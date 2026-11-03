import { useState } from 'react';

import type { FormClipboardSettings, ReplacementRule } from '../../modules/form-clipboard/clipboard-types';
import { defaultReplacementRules, validateReplacementRules } from '../../modules/form-clipboard/replacement-service';
import { ReplacementRulesEditor } from './ReplacementRulesEditor';

interface Props {
  settings: FormClipboardSettings;
  togglePending: boolean;
  /** 未应用的草稿由 App 持有：往返其他页面不丢失，保存/放弃时清空。 */
  draft: ReplacementRule[] | null;
  /** 恢复的会话草稿基于较早的规则，而正式规则已被其他窗口更新时提示核对。 */
  draftConflict: boolean;
  onDraftChange(rules: ReplacementRule[] | null): void;
  onDraftRebase(): void;
  onToggle(enabled: boolean): Promise<void>;
  onSave(rules: ReplacementRule[]): Promise<void>;
}

export function GlobalReplacementSettings({ settings, togglePending, draft, draftConflict, onDraftChange, onDraftRebase, onToggle, onSave }: Props) {
  const [sample, setSample] = useState('https://hsmsh5.demo.ehi.com.cn/resumeDetail');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const rules = draft ?? settings.replacementRules ?? defaultReplacementRules();
  const enabled = settings.replacementEnabled === true;

  const save = async (): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      await onSave(rules);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '替换规则保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="global-replacement">
      <div className="section-heading"><h2>全局输入值替换</h2><label className="replacement-toggle"><input type="checkbox" role="switch" aria-label="启用输入值替换" checked={enabled} disabled={togglePending || saving} onChange={(event) => void onToggle(event.target.checked)} />{enabled ? '已开启' : '已关闭'}</label></div>
      <p className="replacement-help">{enabled ? '粘贴时自动替换，适用于所有新旧表单。' : '当前不执行替换；需要时打开开关，无需重新复制。'}</p>
      <fieldset className="replacement-settings-fields" disabled={saving}>
        <ReplacementRulesEditor title="配置全局规则" saveHint="保存后对所有表单生效；预览仅用于试算，不会打开总开关。" value={sample} rules={rules} onChange={onDraftChange} />
        {draftConflict && <div className="inline-error" role="alert">正式规则已在其他窗口更新。请核对草稿后确认覆盖，或放弃修改。<button className="text-button" onClick={onDraftRebase}>我已核对，允许覆盖</button></div>}
        {draft !== null && <p className="replacement-help">规则有未保存修改，粘贴仍使用已保存规则。</p>}
        <details className="replacement-sample"><summary>试算输入值</summary><label className="field-label">输入示例<input value={sample} onChange={(event) => setSample(event.target.value)} /></label></details>
        <div className="button-row">
          <button className="secondary-button full" disabled={draft === null || draftConflict || Boolean(validateReplacementRules(rules)) || togglePending} onClick={() => void save()}>{saving ? '正在保存…' : '保存全局规则'}</button>
          {draft !== null && <button className="text-button" disabled={saving} onClick={() => onDraftChange(null)}>放弃修改</button>}
        </div>
      </fieldset>
      {error && <div className="inline-error" role="alert">{error}</div>}
    </section>
  );
}
