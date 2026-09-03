import type { FieldMatch, FieldType, FormField } from '../../modules/form-clipboard/clipboard-types';

const MATCH_THRESHOLD = 80;
const textTypes = new Set<FieldType>(['text', 'email', 'url', 'tel']);

const booleanTypes = new Set<FieldType>(['checkbox', 'switch']);

const compatibleType = (left: FieldType, right: FieldType): boolean =>
  left === right ||
  (textTypes.has(left) && textTypes.has(right)) ||
  (booleanTypes.has(left) && booleanTypes.has(right));

const normalized = (value?: string): string => value?.trim().replace(/\s+/g, ' ') ?? '';

const scorePair = (source: FormField, target: FormField): Omit<FieldMatch, 'source' | 'target'> => {
  if (!compatibleType(source.type, target.type)) {
    return { score: 0, reasons: [] };
  }

  let score = source.type === target.type ? 20 : 10;
  const reasons = source.type === target.type ? ['type'] : [];
  const rules: Array<[keyof FormField, number, string]> = [
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

export const matchFields = (sources: FormField[], targets: FormField[]): FieldMatch[] => {
  const usedTargets = new Set<number>();

  return sources.map((source) => {
    const ranked = targets
      .map((target, index) => ({ target, index, ...scorePair(source, target) }))
      .filter((candidate) => !usedTargets.has(candidate.index))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const ambiguous = best && ranked[1]?.score === best.score;

    if (!best || best.score < MATCH_THRESHOLD || ambiguous) {
      return { source, score: best?.score ?? 0, reasons: best?.reasons ?? [] };
    }

    usedTargets.add(best.index);
    return { source, target: best.target, score: best.score, reasons: best.reasons };
  });
};
