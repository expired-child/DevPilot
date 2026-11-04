import type { FieldDescriptor, FieldMatch, FieldType, FormField } from '../../modules/form-clipboard/clipboard-types';

/** 允许回填的最低匹配分：低于它的候选视为无高置信度匹配。 */
export const MATCH_THRESHOLD = 80;

const textTypes = new Set<FieldType>(['text', 'email', 'url', 'tel']);

const booleanTypes = new Set<FieldType>(['checkbox', 'switch']);

const compatibleType = (left: FieldType, right: FieldType): boolean =>
  left === right ||
  (textTypes.has(left) && textTypes.has(right)) ||
  (booleanTypes.has(left) && booleanTypes.has(right));

const normalized = (value?: string): string => value?.trim().replace(/\s+/g, ' ') ?? '';

/** 单个源字段与目标字段的匹配置信度；重渲染后的重定位与整表匹配共用同一套打分。 */
export const scoreFieldPair = (
  source: FieldDescriptor,
  target: FormField,
): Omit<FieldMatch, 'source' | 'target'> => {
  if (!compatibleType(source.type, target.type)) {
    return { score: 0, reasons: [] };
  }

  let score = source.type === target.type ? 20 : 10;
  const reasons = source.type === target.type ? ['type'] : [];
  const rules: Array<[keyof FieldDescriptor, number, string]> = [
    ['name', 100, 'name'],
    ['id', 90, 'id'],
    ['label', 80, 'label'],
    ['ariaLabel', 70, 'aria-label'],
    ['placeholder', 60, 'placeholder'],
    ['selector', 50, 'selector'],
  ];

  for (const [key, points, reason] of rules) {
    const left = source[key];
    const right = target[key];
    if (typeof left === 'string' && normalized(left) !== '' && normalized(left) === normalized(right as string)) {
      score += points;
      reasons.push(reason);
    }
  }

  return { score, reasons };
};

/** 无语义标识的控件只能依赖唯一结构路径；同类型且路径唯一命中才允许回填。 */
const structuralMatch = (source: FieldDescriptor, target: FormField): boolean =>
  source.type === target.type && Boolean(source.selector) && source.selector === target.selector;

/**
 * 在重渲染后的控件集合里按语义找回同一字段。
 * 只在最高分唯一且达到阈值时返回，多个同标签候选一律不猜，交给调用方报告未找到。
 */
export const relocateField = (descriptor: FieldDescriptor, targets: FormField[]): FormField | undefined => {
  const ranked = targets
    .map((target) => ({ target, ...scoreFieldPair(descriptor, target) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best) {
    return undefined;
  }
  if (best.score < MATCH_THRESHOLD && !structuralMatch(descriptor, best.target)) {
    return undefined;
  }
  if (ranked[1]?.score === best.score) {
    return undefined;
  }
  return best.target;
};

export const matchFields = (sources: FormField[], targets: FormField[]): FieldMatch[] => {
  const usedTargets = new Set<number>();

  return sources.map((source) => {
    const ranked = targets
      .map((target, index) => ({ target, index, ...scoreFieldPair(source, target) }))
      .filter((candidate) => !usedTargets.has(candidate.index))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const ambiguous = best && ranked[1]?.score === best.score;

    if (!best || (best.score < MATCH_THRESHOLD && !structuralMatch(source, best.target)) || ambiguous) {
      return { source, score: best?.score ?? 0, reasons: best?.reasons ?? [] };
    }

    usedTargets.add(best.index);
    return { source, target: best.target, score: best.score, reasons: best.reasons };
  });
};