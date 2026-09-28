import type { ReplacementRule } from './clipboard-types';

/** 每次返回独立规则，避免修改某份配置时污染默认值。 */
export const defaultReplacementRules = (): ReplacementRule[] => [
  { mode: 'regex', search: '\\.demo\\.ehi\\.com\\.cn(?=[:/?#]|$)', replacement: '.1hai.cn' },
];

export const validateReplacementRules = (rules: ReplacementRule[] = []): string | undefined => {
  for (const [index, rule] of rules.entries()) {
    if (rule.enabled === false) continue;
    const prefix = `第 ${index + 1} 条替换规则：`;
    if (rule.mode !== 'text' && rule.mode !== 'regex') return `${prefix}不支持的替换方式`;
    if (typeof rule.search !== 'string' || rule.search === '') return `${prefix}查找内容不能为空`;
    if (typeof rule.replacement !== 'string') return `${prefix}替换内容必须是文本`;
    if (rule.mode === 'regex') {
      try {
        new RegExp(rule.search, 'g');
      } catch {
        return `${prefix}正则表达式无效`;
      }
    }
  }
  return undefined;
};

/** 全部匹配、区分大小写；固定文本使用回调，避免把 $1、$& 当成捕获组。 */
export const applyReplacementRules = (value: string, rules: ReplacementRule[] = []): string => {
  const error = validateReplacementRules(rules);
  if (error) throw new Error(error);
  return rules.filter((rule) => rule.enabled !== false).reduce((current, rule) => rule.mode === 'regex'
    ? current.replace(new RegExp(rule.search, 'g'), rule.replacement)
    : current.replaceAll(rule.search, () => rule.replacement), value);
};
