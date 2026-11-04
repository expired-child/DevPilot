import { matchFields } from '../../content/matcher/field-matcher';
import type {
  FieldAssignment,
  FieldDescriptor,
  FieldDiff,
  FillIssue,
  FormClipboardItem,
  FormClipboardSettings,
  FormField,
  FormValue,
} from './clipboard-types';
import { createDiff } from './diff-service';
import { renderTemplate } from './template-service';
import { applyReplacementRules, defaultReplacementRules } from './replacement-service';

export interface FillPlanOptions {
  /** 模板变量，缺省回退到 item.variables。 */
  variables?: Record<string, string>;
  /** 字段值覆盖（预览页手改的唯一字段），优先级最高。 */
  overrides?: Record<string, FormValue>;
  /** 一键模式为 true 时，未修改的唯一字段自动追加递增后缀。 */
  autoUnique?: boolean;
  /** 已使用过的值，用于避免自动去重时撞车。 */
  usedValues?: Iterable<string>;
  /** 本次粘贴不填写的源字段 key，缺省使用 item.excludedFieldKeys。 */
  excludedKeys?: Iterable<string>;
  /** 预览与快捷键均传入当前全局设置，缺省关闭替换。 */
  settings?: FormClipboardSettings;
  /** 预览页显式允许覆盖的形态开关字段 key（源字段 key），缺省全部保留。 */
  overrideDriverKeys?: Iterable<string>;
}

export interface FillPlan {
  diffs: FieldDiff[];
  assignments: FieldAssignment[];
  /** 目标表单当前未渲染、但可能在联动后出现的字段；填充阶段重扫后按描述符定位。 */
  deferred: FieldAssignment[];
  skipped: FillIssue[];
  missingVariables: string[];
  /** 不参与本次粘贴的字段 key（被排除的字段仍保留在 diffs 中供预览展示）。 */
  excludedKeys: string[];
  /** 目标已有值、按默认策略保留未覆盖的形态开关字段 key（源字段 key）。 */
  heldKeys: string[];
  /** 目标表单上必填、但源记录里没有对应值的字段，需要手工补全。 */
  targetOnlyRequired: FormField[];
}

const labelOf = (field: FormField): string => field.label || field.name || field.key;

/** 选择类控件的「未选择」值：填充时跳过而不是报错，避免产生失败噪音。 */
const isEmptyChoice = (value: FormValue): boolean =>
  value === null || value === '' || (Array.isArray(value) && value.length === 0);

const isChoiceType = (field: FormField): boolean => field.type === 'select' || field.type === 'radio';

/**
 * 会切换整套字段的选择类控件（如「适用类型」「指标类型」）。
 * 粘贴时默认保留目标已有值：源值常常属于另一种表单形态，覆盖会把目标切成另一套动态字段。
 */
const DRIVER_HINT = /(类型|类别|\btype\b|\bmode\b)/i;

export const isFormShapeDriver = (field: FormField): boolean =>
  isChoiceType(field) &&
  DRIVER_HINT.test([field.label, field.name, field.id, field.ariaLabel].filter(Boolean).join(' '));

/** 下拉采集到的底层真实值；空值不携带，保持旧消息结构不变。 */
const searchKeyOf = (field: FormField): string | undefined => field.metadata?.selectValue || undefined;

/** 源字段的匹配线索：目标重渲染换了 key 后，填充阶段仍能按语义找回。 */
const descriptorOf = (field: FormField): FieldDescriptor => ({
  type: field.type,
  label: field.label,
  name: field.name,
  id: field.id,
  placeholder: field.placeholder,
  ariaLabel: field.ariaLabel,
  selector: field.selector,
});

/** 生成与既有值不重复的唯一值：order-route → order-route-2 → order-route-3。 */
const nextUniqueValue = (base: string, used: Set<string>): string => {
  const matched = base.match(/^(.*)-(\d+)$/);
  const prefix = matched ? matched[1] : base;
  const start = matched ? Number(matched[2]) + 1 : 2;
  for (let index = start; index < start + 100; index += 1) {
    const candidate = `${prefix}-${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return `${prefix}-${Date.now()}`;
};

/**
 * 构造填充计划：模板渲染 → 输入值替换 → 字段匹配 → 生成填充指令与跳过原因。
 * Service Worker（一键填充）与侧边栏（预览确认）共用同一份逻辑。
 */
export const buildFillPlan = (
  item: FormClipboardItem,
  targetFields: FormField[],
  options: FillPlanOptions = {},
): FillPlan => {
  const variables = options.variables ?? item.variables ?? {};
  const overrides = options.overrides ?? {};
  const uniqueKeys = new Set(item.uniqueFieldKeys ?? []);
  const used = new Set(options.usedValues ?? []);
  const excluded = new Set(options.excludedKeys ?? item.excludedFieldKeys ?? []);
  const replacementEnabled = options.settings?.replacementEnabled === true;
  const globalRules = options.settings?.replacementRules ?? defaultReplacementRules();

  const values: Record<string, FormValue> = {};
  const missing = new Set<string>();
  const skipped: FillIssue[] = [];

  for (const field of item.fields) {
    if (excluded.has(field.key)) {
      continue;
    }
    if (field.key in overrides) {
      values[field.key] = overrides[field.key];
      continue;
    }
    if (typeof field.value !== 'string') {
      if (isChoiceType(field) && isEmptyChoice(field.value)) {
        skipped.push({ label: labelOf(field), reason: '源字段未选择，已跳过' });
        continue;
      }
      values[field.key] = field.value;
      continue;
    }

    const rendered = renderTemplate(field.value, variables);
    if (rendered.missing.length > 0) {
      rendered.missing.forEach((name) => missing.add(name));
      skipped.push({ label: labelOf(field), reason: `缺少变量值：${rendered.missing.join('、')}` });
      continue;
    }

    let value: string;
    try {
      value = rendered.value;
      if (replacementEnabled) {
        // 全局规则只转换文本输入，避免改变下拉框、单选框等选项标识。
        if (['text', 'textarea', 'url', 'email', 'tel', 'number'].includes(field.type)) {
          value = applyReplacementRules(value, globalRules);
        }
        value = applyReplacementRules(value, field.replacementRules);
      }
    } catch (error) {
      skipped.push({ label: labelOf(field), reason: error instanceof Error ? error.message : '输入值替换失败' });
      continue;
    }
    if (isChoiceType(field) && isEmptyChoice(value)) {
      skipped.push({ label: labelOf(field), reason: '源字段未选择，已跳过' });
      continue;
    }
    if (options.autoUnique && uniqueKeys.has(field.key) && value === field.value) {
      value = nextUniqueValue(value, used);
      used.add(value);
    }
    values[field.key] = value;
  }

  const diffs = createDiff(matchFields(item.fields, targetFields), values, item.uniqueFieldKeys ?? []);

  // 形态开关：目标已有不同值时默认保留，避免粘贴后目标表单被切成另一套字段、后续值全部错位。
  const forced = new Set(options.overrideDriverKeys ?? []);
  const held = new Set<string>();
  for (const diff of diffs) {
    if (!diff.target || excluded.has(diff.source.key) || forced.has(diff.source.key)) continue;
    if (!isFormShapeDriver(diff.source) || isEmptyChoice(diff.target.value)) continue;
    if (JSON.stringify(diff.target.value) === JSON.stringify(diff.nextValue)) continue;
    diff.status = 'HELD';
    held.add(diff.source.key);
  }

  /** 目标表单按选择项动态渲染的字段：先记为延迟填充，由填充阶段重扫后定位。 */
  const deferred: FieldAssignment[] = [];
  const assignments = diffs.flatMap<FieldAssignment>((diff) => {
    if (excluded.has(diff.source.key) || held.has(diff.source.key)) {
      return [];
    }
    if (!(diff.source.key in values)) {
      return [];
    }
    if (!diff.target) {
      deferred.push({
        targetKey: '',
        sourceKey: diff.source.key,
        label: labelOf(diff.source),
        value: diff.nextValue,
        searchKey: searchKeyOf(diff.source),
        descriptor: descriptorOf(diff.source),
      });
      return [];
    }
    return [
      {
        targetKey: diff.target.key,
        targetSelector: diff.target.selector,
        label: labelOf(diff.source),
        value: diff.nextValue,
        searchKey: searchKeyOf(diff.source),
        descriptor: descriptorOf(diff.source),
      },
    ];
  });

  const matchedTargetKeys = new Set(diffs.flatMap((diff) => (diff.target ? [diff.target.key] : [])));
  const targetOnlyRequired = targetFields.filter(
    (field) => field.required && !matchedTargetKeys.has(field.key),
  );

  return {
    diffs,
    assignments,
    deferred,
    skipped,
    missingVariables: [...missing],
    excludedKeys: [...excluded],
    heldKeys: [...held],
    targetOnlyRequired,
  };
};
