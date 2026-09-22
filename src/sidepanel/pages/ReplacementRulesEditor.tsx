import type { ReplacementRule } from '../../modules/form-clipboard/clipboard-types';
import { applyReplacementRules, validateReplacementRules } from '../../modules/form-clipboard/replacement-service';
import { renderTemplate } from '../../modules/form-clipboard/template-service';

interface Props {
  value: string;
  variables?: Record<string, string>;
  rules: ReplacementRule[];
  title?: string;
  saveHint?: string;
  onChange(rules: ReplacementRule[]): void;
}

export function ReplacementRulesEditor({ value, variables = {}, rules, title = '输入值替换', saveHint = '保存字段模板后生效；粘贴时需开启总开关。', onChange }: Props) {
  const error = validateReplacementRules(rules);
  const rendered = renderTemplate(value, variables);
  const update = (index: number, patch: Partial<ReplacementRule>): void =>
    onChange(rules.map((rule, position) => position === index ? { ...rule, ...patch } : rule));
  const move = (index: number, offset: number): void => {
    const next = [...rules];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(next);
  };

  return (
    <details className="replacement-editor">
      <summary>{title}{rules.length > 0 ? ` · ${rules.length} 条规则` : ' · 未配置'}</summary>
      <p className="replacement-help">按顺序替换全部匹配，区分大小写；替换为空表示删除。正则不加 / /，支持 $1、$2 捕获组。{saveHint}</p>
      {rules.map((rule, index) => (
        <div className="replacement-rule" key={index}>
          <div className="replacement-rule-head">
            <label>第 {index + 1} 条 <select aria-label={`第 ${index + 1} 条替换方式`} value={rule.mode} onChange={(event) => update(index, { mode: event.target.value as ReplacementRule['mode'] })}>
              <option value="text">固定文本</option><option value="regex">正则表达式</option>
            </select></label>
            <div className="replacement-rule-actions">
              <button className="text-button" aria-label={`上移第 ${index + 1} 条规则`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
              <button className="text-button" aria-label={`下移第 ${index + 1} 条规则`} disabled={index === rules.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button className="text-button danger" aria-label={`删除第 ${index + 1} 条规则`} onClick={() => onChange(rules.filter((_, position) => position !== index))}>删除</button>
            </div>
          </div>
          <label className="include-toggle"><input type="checkbox" checked={rule.enabled !== false} onChange={(event) => update(index, { enabled: event.target.checked })} />启用第 {index + 1} 条规则</label>
          <label className="field-label">{rule.mode === 'regex' ? '匹配正则' : '查找文本'}<textarea rows={1} value={rule.search} onChange={(event) => update(index, { search: event.target.value })} placeholder={rule.mode === 'regex' ? '\\.demo\\.ehi\\.com\\.cn(?=[:/?#]|$)' : 'a'} /></label>
          <label className="field-label">替换为<textarea rows={1} value={rule.replacement} onChange={(event) => update(index, { replacement: event.target.value })} placeholder="留空表示删除" /></label>
        </div>
      ))}
      <button className="small-button" onClick={() => onChange([...rules, { mode: 'text', search: '', replacement: '' }])}>添加替换规则</button>
      {error ? <div className="inline-error" role="alert">{error}</div> : rules.length > 0 && (
        <div className="replacement-preview"><strong>替换预览</strong><p>{rendered.missing.length > 0 ? `请在粘贴预览中填写变量：${rendered.missing.join('、')}` : applyReplacementRules(rendered.value, rules) || '（空文本）'}</p></div>
      )}
    </details>
  );
}
