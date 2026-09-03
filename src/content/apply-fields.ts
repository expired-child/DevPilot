import { getFieldAdapter } from './adapters';
import { scanForm, type ScannedField } from './scanner/form-scanner';
import type { FieldAssignment, FillReport, FormValue } from '../modules/form-clipboard/clipboard-types';

/** 每次重扫的间隔：足够 React 完成一次联动渲染，又不至于让用户感到卡顿。 */
const RETRY_INTERVAL_MS = 100;

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

const indexControls = (controls: ScannedField[]): Map<string, ScannedField> =>
  new Map(controls.map((entry) => [entry.field.key, entry]));

/** 等待预算：按「已消耗的等待时长」记账，多个缺失字段共用同一份，避免各自等满一轮。 */
interface WaitBudget {
  remainingMs: number;
}

/**
 * 查找目标控件，缺失时重扫等待。
 * 条件渲染字段（如选择「法务类型」后才挂载的「经办法务」）在首次扫描时还不在 DOM 里，
 * 直接跳过会误判；给它一段渲染窗口期再重扫，仍找不到才判定页面已变化。
 */
const findTarget = async (
  key: string,
  byKey: Map<string, ScannedField>,
  budget: WaitBudget,
): Promise<ScannedField | undefined> => {
  const existing = byKey.get(key);
  if (existing) {
    return existing;
  }

  while (budget.remainingMs > 0) {
    const sleep = Math.min(RETRY_INTERVAL_MS, budget.remainingMs);
    await wait(sleep);
    budget.remainingMs -= sleep;

    // 重扫结果整体合并：联动渲染往往一次带出多个新字段，后续字段就不必再等一轮。
    const rescanned = indexControls(scanForm().controls);
    rescanned.forEach((entry, entryKey) => {
      if (!byKey.has(entryKey)) {
        byKey.set(entryKey, entry);
      }
    });

    const found = byKey.get(key);
    if (found) {
      return found;
    }
  }

  return undefined;
};

export const applyFields = async (assignments: FieldAssignment[]): Promise<FillReport> => {
  const byKey = indexControls(scanForm().controls);
  const report: FillReport = { success: 0, skipped: 0, failed: 0, issues: [] };
  const budget: WaitBudget = { remainingMs: RETRY_BUDGET_MS };

  for (const assignment of assignments) {
    const target = await findTarget(assignment.targetKey, byKey, budget);

    if (!target) {
      report.skipped += 1;
      report.issues.push({ label: assignment.label, reason: '页面变化后未找到目标字段' });
      continue;
    }
    if (target.field.disabled) {
      report.skipped += 1;
      report.issues.push({ label: assignment.label, reason: '目标字段已禁用' });
      continue;
    }

    const adapter = getFieldAdapter(target.element);
    if (!adapter) {
      report.skipped += 1;
      report.issues.push({
        label: assignment.label,
        reason: `暂不支持该控件（${describeControl(target.element)}）`,
      });
      continue;
    }

    try {
      await adapter.setValue(target.element, assignment.value);
      if (!sameValue(adapter.getValue(target.element), assignment.value)) {
        throw new Error('控件未接受新值');
      }
      report.success += 1;
    } catch (error) {
      report.failed += 1;
      report.issues.push({
        label: assignment.label,
        reason: error instanceof Error ? error.message : '填充失败',
      });
    }
  }

  return report;
};
