import { useState } from 'react';

import type { FormClipboardSettings, ReplacementRule } from '../../modules/form-clipboard/clipboard-types';
import { defaultReplacementRules, validateReplacementRules } from '../../modules/form-clipboard/replacement-service';
import { ReplacementRulesEditor } from './ReplacementRulesEditor';

interface Props {
  settings: FormClipboardSettings;
  togglePending: boolean;
  onToggle(enabled: boolean): Promise<void>;
  onSave(rules: ReplacementRule[]): Promise<void>;
}

export function GlobalReplacementSettings({ settings, togglePending, onToggle, onSave }: Props) {
  const [draft, setDraft] = useState<ReplacementRule[] | null>(null);
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
      setDraft(null);
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
        <ReplacementRulesEditor title="配置全局规则" saveHint="保存后对所有表单生效；预览仅用于试算，不会打开总开关。" value={sample} rules={rules} onChange={setDraft} />
        {draft !== null && <p className="replacement-help">规则有未保存修改，粘贴仍使用已保存规则。</p>}
        <details className="replacement-sample"><summary>试算输入值</summary><label className="field-label">输入示例<input value={sample} onChange={(event) => setSample(event.target.value)} /></label></details>
        <button className="secondary-button full" disabled={draft === null || Boolean(validateReplacementRules(rules)) || togglePending} onClick={() => void save()}>{saving ? '正在保存…' : '保存全局规则'}</button>
      </fieldset>
      {error && <div className="inline-error" role="alert">{error}</div>}
    </section>
  );
}
