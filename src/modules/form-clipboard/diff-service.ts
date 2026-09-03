import type { FieldDiff, FieldMatch, FormValue } from './clipboard-types';

const equalValue = (left: FormValue, right: FormValue): boolean => JSON.stringify(left) === JSON.stringify(right);

export const createDiff = (
  matches: FieldMatch[],
  values: Record<string, FormValue>,
  uniqueFieldKeys: string[],
): FieldDiff[] => {
  const unique = new Set(uniqueFieldKeys);

  return matches.map((match) => {
    const nextValue = values[match.source.key] ?? match.source.value;
    const status = !match.target
      ? 'UNMATCHED'
      : unique.has(match.source.key)
        ? 'UNIQUE'
        : equalValue(match.source.value, nextValue)
          ? 'UNCHANGED'
          : 'CHANGED';

    return {
      source: match.source,
      target: match.target,
      originalValue: match.source.value,
      nextValue,
      status,
      score: match.score,
    };
  });
};
