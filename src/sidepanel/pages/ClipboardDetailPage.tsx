import { useRef, useState, type Dispatch, type SetStateAction } from 'react';

import type { FormClipboardDetails, FormClipboardItem, FormField, ReplacementRule } from '../../modules/form-clipboard/clipboard-types';
import { validateReplacementRules } from '../../modules/form-clipboard/replacement-service';
import { ReplacementRulesEditor } from './ReplacementRulesEditor';

interface Props {
  item: FormClipboardItem;
  onBack(): void;
  onPaste(): Promise<void>;
  onSave(details: FormClipboardDetails): Promise<void>;
  onDelete(): Promise<void>;
}

const displayValue = (value: FormField['value']): string => Array.isArray(value) ? value.join(', ') : String(value ?? '');

const sameKeys = (left: Set<string>, right: string[] | undefined): boolean =>
  left.size === (right?.length ?? 0) && [...left].every((key) => right?.includes(key));

export function ClipboardDetailPage({ item, onBack, onPaste, onSave, onDelete }: Props) {
  const [name, setName] = useState(item.name);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rules, setRules] = useState<Record<string, ReplacementRule[]>>({});
  const [pinned, setPinned] = useState(Boolean(item.pinned));
  const [uniqueKeys, setUniqueKeys] = useState(() => new Set(item.uniqueFieldKeys ?? []));
  const [excludedKeys, setExcludedKeys] = useState(() => new Set(item.excludedFieldKeys ?? []));
  const [saving, setSaving] = useState(false);
  const [openingPreview, setOpeningPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const openingRef = useRef(false);

  const normalizedName = name.trim() || item.name;
  const fields = item.fields.map((field) => typeof field.value === 'string'
    ? { ...field, value: values[field.key] ?? field.value, replacementRules: rules[field.key] ?? field.replacementRules }
    : field);
  const ruleError = fields.flatMap((field) => {
    const issue = validateReplacementRules(field.replacementRules);
    return issue ? [`${field.label || field.name || field.key}：${issue}`] : [];
  })[0];
  const dirty = name !== item.name || pinned !== Boolean(item.pinned) ||
    !sameKeys(uniqueKeys, item.uniqueFieldKeys) || !sameKeys(excludedKeys, item.excludedFieldKeys) ||
    fields.some((field, index) => field.value !== item.fields[index].value ||
      JSON.stringify(field.replacementRules) !== JSON.stringify(item.fields[index].replacementRules));

  const toggleKey = (setter: Dispatch<SetStateAction<Set<string>>>, key: string, enabled: boolean): void => {
    setter((current) => {
      const next = new Set(current);
      if (enabled) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const save = async (): Promise<boolean> => {
    if (savingRef.current) return false;
    if (ruleError) {
      setError(ruleError);
      return false;
    }
    if (!dirty) return true;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: normalizedName, fields, pinned, uniqueFieldKeys: [...uniqueKeys], excludedFieldKeys: [...excludedKeys] });
      setName(normalizedName);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。');
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const leave = (): void => {
    if (savingRef.current || openingRef.current) return;
    if (!dirty || window.confirm('有未保存的修改，确定放弃并返回吗？')) onBack();
  };

  const paste = async (): Promise<void> => {
    if (savingRef.current || openingRef.current) return;
    openingRef.current = true;
    setOpeningPreview(true);
    setError(null);
    try {
      if (await save()) await onPaste();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开预览，请重试。');
    } finally {
      openingRef.current = false;
      setOpeningPreview(false);
    }
  };

  const excludedCount = excludedKeys.size;

  return (
    <>
      <header className="page-header"><button className="icon-button" disabled={saving || openingPreview} onClick={leave} aria-label="返回表单历史">←</button><div><span className="eyebrow">剪贴板详情</span><h1>{item.name}</h1></div></header>

      <section className="detail-card">
        <label className="field-label">名称<input value={name} disabled={saving || openingPreview} onChange={(event) => setName(event.target.value)} /></label>
        <div className="button-row"><button className="secondary-button" disabled={saving || openingPreview} onClick={() => setPinned((current) => !current)}>{pinned ? '取消固定' : '固定'}</button><span className="save-state" role="status">{saving ? '正在保存…' : dirty ? '有未保存的修改' : '更改已保存'}</span></div>
        <dl className="facts"><div><dt>来源</dt><dd title={item.source.title || item.source.host}>{item.source.title || item.source.host}</dd></div><div><dt>网址</dt><dd title={item.source.url}>{item.source.host}</dd></div><div><dt>字段</dt><dd>{item.fields.length}</dd></div><div><dt>复制时间</dt><dd>{new Date(item.createdAt).toLocaleString()}</dd></div></dl>
      </section>

      <section className="fields-section">
        <div className="section-heading"><h2>字段与变量</h2><span>将粘贴 {item.fields.length - excludedCount}/{item.fields.length} · 使用 {'{{name}}'} 定义变量</span></div>
        <div className="field-list">
          {item.fields.map((field) => {
            const isUnique = uniqueKeys.has(field.key);
            const isExcluded = excludedKeys.has(field.key);
            const canBeUnique = typeof field.value === 'string';
            return (
              <article className={`field-card${isExcluded ? ' excluded' : ''}`} key={field.key}>
                <div className="field-card-head"><strong>{field.label || field.name || field.id || field.key}</strong><span className="head-toggles"><label className="include-toggle"><input type="checkbox" checked={!isExcluded} disabled={saving || openingPreview} onChange={(event) => toggleKey(setExcludedKeys, field.key, !event.target.checked)} />粘贴</label><label className="unique-toggle"><input type="checkbox" checked={isUnique} disabled={!canBeUnique || saving || openingPreview} onChange={(event) => toggleKey(setUniqueKeys, field.key, event.target.checked)} />唯一字段</label></span></div>
                {typeof field.value === 'string' ? (
                  <textarea aria-label={`${field.label || field.name || field.id || field.key}的值`} rows={field.value.length > 80 ? 3 : 1} value={values[field.key] ?? field.value} disabled={saving || openingPreview} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />
                ) : <div className="value-preview">{displayValue(field.value)}</div>}
                <small>{field.key} · {field.type}</small>
                {typeof field.value === 'string' && <fieldset className="field-rule-controls" disabled={saving || openingPreview}><ReplacementRulesEditor value={values[field.key] ?? field.value} variables={item.variables} rules={rules[field.key] ?? field.replacementRules ?? []} onChange={(next) => setRules((current) => ({ ...current, [field.key]: next }))} /></fieldset>}
              </article>
            );
          })}
        </div>
        {ruleError && <div className="inline-error" role="alert">{ruleError}</div>}
        <button className="secondary-button full" disabled={!dirty || Boolean(ruleError) || saving || openingPreview} onClick={() => void save()}>保存更改</button>
      </section>

      <footer className="sticky-actions">{error && <div className="inline-error" role="alert">{error}</div>}<button className="primary-button" disabled={Boolean(ruleError) || saving || openingPreview} onClick={() => void paste()}>{openingPreview ? '正在打开预览…' : dirty ? '保存并预览填充' : '预览并填充此表单'}</button><button className="text-button danger" disabled={saving || openingPreview} onClick={() => { if (window.confirm(`确定删除“${item.name}”吗？`)) void onDelete(); }}>删除</button></footer>
    </>
  );
}
