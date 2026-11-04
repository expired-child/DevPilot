import { getFieldAdapter } from './adapters';
import type { FieldAdapter } from './adapters/field-adapter';
import { relocateField } from './matcher/field-matcher';
import { scanForm, type ScannedField } from './scanner/form-scanner';
import { scopeElement } from './scanner/scope-registry';
import type { FieldAssignment, FillReport, FormTargetSnapshot, FormValue } from '../modules/form-clipboard/clipboard-types';
import { createFingerprint } from '../modules/form-clipboard/fingerprint';

/** 每次重扫的间隔：足够 React 完成一次联动渲染，又不至于让用户感到卡顿。 */
const RETRY_INTERVAL_MS = 100;
const SETTLE_MS = 50;

/**
 * 整个填充过程为「等待条件渲染」预留的总时长。
 * 多个缺失字段共用这份预算，避免 N 个字段各等 2 秒叠加成超长等待。
 */
const RETRY_BUDGET_MS = 2000;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const sameValue = (left: FormValue, right: FormValue): boolean => {
  if (Array.isArray(left) && Array.isArray(right)) {
    // 多选控件回读的顺序可能与赋值顺序不同（框架会重排标签），按集合比较。
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.length === sortedRight.length && sortedLeft.every((entry, index) => entry === sortedRight[index]);
  }
  return JSON.stringify(left) === JSON.stringify(right);
};

/**
 * 回读校验：适配器可声明自己的等价规则（如下拉按编码匹配到改名后的显示文本），
 * 未声明时沿用字段值的严格比较。
 */
const valueMatches = (adapter: FieldAdapter, current: FormValue, expected: FormValue): boolean =>
  adapter.matchesValue ? adapter.matchesValue(current, expected) : sameValue(current, expected);

/** 描述控件特征，便于在填充报告里说明「暂不支持」的到底是哪种控件。 */
const describeControl = (element: HTMLElement): string => {
  const tag = element.tagName.toLowerCase();
  const type = element instanceof HTMLInputElement ? `[type="${element.type}"]` : '';
  const role = element.getAttribute('role');
  const rolePart = role ? `[role="${role}"]` : '';
  const className = typeof element.className === 'string' ? element.className.trim().split(/\s+/).slice(0, 2) : [];
  const classPart = className.length ? `.${className.join('.')}` : '';
  return `${tag}${type}${rolePart}${classPart}`;
};

/** 等待预算：按「已消耗的等待时长」记账，多个缺失字段共用同一份，避免各自等满一轮。 */
interface WaitBudget {
  remainingMs: number;
}

/**
 * 联动表单可能层层展开：父级填好后才渲染子级字段，或子级的远程选项才加载完成。
 * 一轮填不完时再重扫重试，最多几轮，避免无限循环。
 */
const MAX_APPLY_PASSES = 3;

/**
 * 定位目标控件：先按 key 精确命中；key 未命中或延迟填充（key 为空）时，
 * 用源字段描述符在当前控件集合里重新匹配。
 * 联动重渲染会换掉无 name/label 控件的结构路径（key 随之变化），只靠 key 会误判为字段缺失。
 */
const locateControl = (
  assignment: FieldAssignment,
  controls: ScannedField[],
  usedKeys: ReadonlySet<string>,
): ScannedField | undefined => {
  const byKey = assignment.targetKey
    ? controls.find((entry) => entry.field.key === assignment.targetKey)
    : undefined;
  if (byKey) {
    return byKey;
  }
  if (!assignment.descriptor) {
    return undefined;
  }
  const free = controls.filter((entry) => !usedKeys.has(entry.field.key));
  const matched = relocateField(assignment.descriptor, free.map((entry) => entry.field));
  return matched ? free.find((entry) => entry.field.key === matched.key) : undefined;
};

/**
 * 查找目标控件，缺失时重扫等待。
 * 条件渲染字段（如选择「法务类型」后才挂载的「经办法务」）在首次扫描时还不在 DOM 里，
 * 直接跳过会误判；给它一段渲染窗口期再重扫，仍找不到才判定页面已变化。
 */
const findTarget = async (
  assignment: FieldAssignment,
  scope: HTMLElement,
  budget: WaitBudget,
  usedKeys: ReadonlySet<string>,
): Promise<ScannedField | undefined> => {
  const rescan = (): ScannedField[] => scanForm(document, undefined, scope).controls;
  const existing = locateControl(assignment, rescan(), usedKeys);
  if (existing) {
    return existing;
  }

  while (budget.remainingMs > 0) {
    const sleep = Math.min(RETRY_INTERVAL_MS, budget.remainingMs);
    await wait(sleep);
    budget.remainingMs -= sleep;

    const found = locateControl(assignment, rescan(), usedKeys);
    if (found) {
      return found;
    }
  }

  return undefined;
};

/** 同一行的判定容差：两列表单里左右两列的 top 常差几个像素。 */
const ROW_TOLERANCE_PX = 8;

/** 会改变表单形态的控件类型：选中后可能新增字段，或让后面的下拉才有选项。 */
const SHAPE_CHANGING_TYPES: ReadonlySet<string> = new Set(['select', 'radio', 'switch', 'checkbox']);

/** 控件在视口里的位置；未布局（隐藏或尚未渲染）的控件返回 null。 */
const rectOf = (element: HTMLElement): DOMRect | null => {
  if (typeof element.getBoundingClientRect !== 'function') {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
};

/**
 * 按视觉位置排列待填字段：先从上到下（top），同一行再从左到右（left）。
 * 联动表单里父级下拉通常排在子级之前（如所属系统 → 二级分类），按这个顺序填，
 * 子级下拉的选项才是可用的。尚未渲染的延迟字段和定位不到的字段排在最后；
 * 位置完全相同时退回 DOM 顺序（sort 是稳定排序）。
 */
const orderByPage = (
  assignments: FieldAssignment[],
  scope: HTMLElement,
  usedKeys: ReadonlySet<string>,
): FieldAssignment[] => {
  const controls = scanForm(document, undefined, scope).controls;
  const entries = assignments.map((assignment, index) => {
    const control = locateControl(assignment, controls, usedKeys);
    const rect = control ? rectOf(control.element) : null;
    return {
      assignment,
      index,
      domIndex: control ? controls.indexOf(control) : Number.POSITIVE_INFINITY,
      top: rect ? rect.top : Number.POSITIVE_INFINITY,
      left: rect ? rect.left : Number.POSITIVE_INFINITY,
    };
  });
  entries.sort((left, right) => {
    const leftPlaced = Number.isFinite(left.top);
    const rightPlaced = Number.isFinite(right.top);
    if (leftPlaced !== rightPlaced) {
      return leftPlaced ? -1 : 1;
    }
    if (!leftPlaced) {
      // 都拿不到视觉位置时退回 DOM 顺序（扫描结果本身就是 DOM 顺序）。
      if (left.domIndex !== right.domIndex) {
        return left.domIndex - right.domIndex;
      }
      return left.index - right.index;
    }
    if (Math.abs(left.top - right.top) > ROW_TOLERANCE_PX) {
      return left.top - right.top;
    }
    if (left.left !== right.left) {
      return left.left - right.left;
    }
    return left.index - right.index;
  });
  return entries.map((entry) => entry.assignment);
};

export const applyFields = async (assignments: FieldAssignment[], expectedTarget?: FormTargetSnapshot): Promise<FillReport> => {
  // 带作用域标识时必须找回扫描时的同一个表单容器；
  // 作用域已被重渲染替换就拒绝填充，不自动换选其他表单。
  const lockedScope = expectedTarget?.scopeId ? scopeElement(expectedTarget.scopeId) : undefined;
  if (expectedTarget?.scopeId && (!lockedScope || !lockedScope.isConnected)) {
    throw new Error('目标表单已变化，请重新扫描后再填充。');
  }
  // 整次填充锁定表单；控件失焦或下拉弹出后不能转而扫描其他表单。
  const scanned = scanForm(document, undefined, lockedScope);
  if (expectedTarget && (
    scanned.result.source.url !== expectedTarget.url ||
    createFingerprint(scanned.result.source.host, scanned.result.fields) !== expectedTarget.fingerprint
  )) {
    throw new Error('目标页面或表单已变化，请重新执行填充。');
  }
  const { scope } = scanned;
  const report: FillReport = { success: 0, skipped: 0, failed: 0, issues: [] };
  const budget: WaitBudget = { remainingMs: RETRY_BUDGET_MS };
  const usedKeys = new Set<string>();
  /** 实际填充成功的控件 key；重定位后可能与源字段的 targetKey 不同，回读按它核对。 */
  const applied = new Map<FieldAssignment, string>();
  /** 每个字段只保留最后一次尝试的结论，重试成功的不再计入失败/跳过。 */
  const outcome = new Map<FieldAssignment, { failed: boolean; reason: string }>();
  let remaining = assignments;

  for (let pass = 0; pass < MAX_APPLY_PASSES && remaining.length > 0; pass += 1) {
    // 每轮都按当前页面的视觉顺序重排：上一轮填好父级后出现的新字段也要归到自己的位置。
    let queue = orderByPage(remaining, scope, usedKeys);
    let cursor = 0;
    let reorder = false;
    let progressed = false;
    const retry: FieldAssignment[] = [];

    while (cursor < queue.length) {
      if (reorder) {
        // 父级选中后页面新增了字段：只重排还没轮到的部分，让新字段按视觉位置插队。
        queue = [...queue.slice(0, cursor), ...orderByPage(queue.slice(cursor), scope, usedKeys)];
        reorder = false;
      }
      const assignment = queue[cursor];
      cursor += 1;

      const target = await findTarget(assignment, scope, budget, usedKeys);

      if (!target) {
        outcome.set(assignment, { failed: false, reason: '页面变化后未找到目标字段' });
        retry.push(assignment);
        continue;
      }
      // 依赖项填好前可能是禁用态（如选择「是否跳转」后 Rid 才启用），留到下一轮再看。
      if (target.field.disabled) {
        outcome.set(assignment, { failed: false, reason: '目标字段已禁用' });
        retry.push(assignment);
        continue;
      }

      const adapter = getFieldAdapter(target.element);
      if (!adapter) {
        outcome.set(assignment, {
          failed: false,
          reason: `暂不支持该控件（${describeControl(target.element)}）`,
        });
        continue;
      }

      try {
        await adapter.setValue(target.element, assignment.value, { searchKey: assignment.searchKey });
        await wait(SETTLE_MS);
        const current = await findTarget(assignment, scope, budget, usedKeys);
        const currentAdapter = current && getFieldAdapter(current.element);
        if (!current || !currentAdapter || !valueMatches(currentAdapter, currentAdapter.getValue(current.element), assignment.value)) {
          throw new Error('控件未接受新值');
        }
        usedKeys.add(target.field.key);
        applied.set(assignment, target.field.key);
        outcome.delete(assignment);
        progressed = true;
        reorder = SHAPE_CHANGING_TYPES.has(assignment.descriptor?.type ?? '');
      } catch (error) {
        outcome.set(assignment, {
          failed: true,
          reason: error instanceof Error ? error.message : '填充失败',
        });
        retry.push(assignment);
      }
    }

    // 本轮结束后回读已填字段：后面字段的联动可能把它们清空
    // （如改「指标类型」会重置「所属系统」），放回重试队列由下一轮补填，
    // 而不是等到最后统一报「被联动重置」。
    const controlsAfter = applied.size > 0 ? scanForm(document, undefined, scope).controls : [];
    for (const [entry, key] of [...applied]) {
      const current = controlsAfter.find((control) => control.field.key === key) ??
        locateControl({ ...entry, targetKey: key }, controlsAfter, usedKeys);
      const adapter = current && getFieldAdapter(current.element);
      if (!current || !adapter || !valueMatches(adapter, adapter.getValue(current.element), entry.value)) {
        applied.delete(entry);
        if (!retry.includes(entry)) {
          retry.push(entry);
        }
      }
    }

    remaining = retry;
    // 本轮没有任何字段填成功，再重试也不会有新进展，提前结束。
    if (!progressed) break;
  }

  for (const assignment of remaining) {
    const result = outcome.get(assignment);
    if (!result) continue;
    if (result.failed) {
      report.failed += 1;
    } else {
      report.skipped += 1;
    }
    report.issues.push({ label: assignment.label, reason: result.reason });
  }

  // 后续字段的联动也可能清空之前已填的值，成功数以最终页面回读为准。
  const finalControls = scanForm(document, undefined, scope).controls;
  for (const [assignment, targetKey] of applied) {
    const current = finalControls.find((entry) => entry.field.key === targetKey) ??
      // 延迟字段下发时 targetKey 为空，回读必须用填充时定位到的 key 继续找。
      locateControl({ ...assignment, targetKey }, finalControls, usedKeys);
    const adapter = current && getFieldAdapter(current.element);
    if (!current || !adapter || !valueMatches(adapter, adapter.getValue(current.element), assignment.value)) {
      report.failed += 1;
      report.issues.push({ label: assignment.label, reason: '字段值被页面联动重置或字段已移除' });
    } else {
      report.success += 1;
    }
  }

  return report;
};
