import { matchFields } from '../../content/matcher/field-matcher';
import type {
  FieldAssignment,
  FieldDiff,
  FillIssue,
  FormClipboardItem,
  FormField,
  FormValue,
} from './clipboard-types';
import { createDiff } from './diff-service';
import { renderTemplate } from './template-service';

export interface FillPlanOptions {
  /** 模板变量，缺省回退到 item.variables。 */
  variables?: Record<string, string>;
  /** 字段值覆盖（预览页手改的唯一字段），优先级最高。 */
  overrides?: Record<string, FormValue>;
  /** 一键模式为 true 时，未修改的唯一字段自动追加递增后缀。 */
  autoUnique?: boolean;
  /** 已使用过的值，用于避免自动去重时撞车。 */
  usedValues?: Iterable<string>;
}

export interface FillPlan {
  diffs: FieldDiff[];
  assignments: FieldAssignment[];
  skipped: FillIssue[];
  missingVariables: string[];
}

const labelOf = (field: FormField): string => field.label || field.name || field.key;

/** 选择类控件的「未选择」值：填充时跳过而不是报错，避免产生失败噪音。 */
const isEmptyChoice = (value: FormValue): boolean =>
  value === null || value === '' || (Array.isArray(value) && value.length === 0);

const isChoiceType = (field: FormField): boolean => field.type === 'select' || field.type === 'radio';

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
 * 构造填充计划：模板渲染 → 字段匹配 → 生成填充指令与跳过原因。
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

  const values: Record<string, FormValue> = {};
  const missing = new Set<string>();
  const skipped: FillIssue[] = [];

  for (const field of item.fields) {
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

    let value: FormValue = rendered.value;
    if (isChoiceType(field) && isEmptyChoice(value)) {
      skipped.push({ label: labelOf(field), reason: '源字段未选择，已跳过' });
      continue;
    }
    if (options.autoUnique && uniqueKeys.has(field.key) && rendered.value === field.value) {
      value = nextUniqueValue(rendered.value, used);
      used.add(value);
    }
    values[field.key] = value;
  }

  const diffs = createDiff(matchFields(item.fields, targetFields), values, item.uniqueFieldKeys ?? []);
  const assignments = diffs.flatMap<FieldAssignment>((diff) => {
    if (!diff.target) {
      skipped.push({ label: labelOf(diff.source), reason: '未找到高置信度匹配字段' });
      return [];
    }
    if (!(diff.source.key in values)) {
      return [];
    }
    return [
      {
        targetKey: diff.target.key,
        targetSelector: diff.target.selector,
        label: labelOf(diff.source),
        value: diff.nextValue,
      },
    ];
  });

  return { diffs, assignments, skipped, missingVariables: [...missing] };
};
