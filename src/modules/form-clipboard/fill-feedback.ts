import type { FillIssue } from './clipboard-types';

/** 全部字段被跳过时，统计出现最多的跳过原因，让“为什么没有可填充字段”可理解。 */
export const topSkipReason = (skipped: FillIssue[]): { reason: string; count: number } | undefined => {
  if (skipped.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const issue of skipped) {
    counts.set(issue.reason, (counts.get(issue.reason) ?? 0) + 1);
  }
  const [reason, count] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]!;
  return { reason, count };
};
