import { useState } from 'react';

import type { FormClipboardItem, FormField } from '../../modules/form-clipboard/clipboard-types';

interface Props {
  item: FormClipboardItem;
  onBack(): void;
  onPaste(): void;
  onRename(name: string): Promise<void>;
  onDelete(): Promise<void>;
  onPin(): Promise<void>;
  onUnique(fieldKey: string, unique: boolean): Promise<void>;
  onSaveFields(fields: FormField[]): Promise<void>;
}

const displayValue = (value: FormField['value']): string => Array.isArray(value) ? value.join(', ') : String(value ?? '');

export function ClipboardDetailPage({ item, onBack, onPaste, onRename, onDelete, onPin, onUnique, onSaveFields }: Props) {
  const [name, setName] = useState(item.name);
  const [values, setValues] = useState<Record<string, string>>({});

  const saveFields = (): void => {
    void onSaveFields(item.fields.map((field) => typeof field.value === 'string' ? { ...field, value: values[field.key] ?? field.value } : field));
  };

  return (
    <>
      <header className="page-header"><button className="icon-button" onClick={onBack}>←</button><div><span className="eyebrow">剪贴板详情</span><h1>{item.name}</h1></div></header>

      <section className="detail-card">
        <label className="field-label">名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="button-row"><button className="secondary-button" onClick={() => void onRename(name)}>保存名称</button><button className="secondary-button" onClick={() => void onPin()}>{item.pinned ? '取消固定' : '固定'}</button></div>
        <dl className="facts"><div><dt>来源</dt><dd>{item.source.title || item.source.host}</dd></div><div><dt>网址</dt><dd title={item.source.url}>{item.source.host}</dd></div><div><dt>字段</dt><dd>{item.fields.length}</dd></div><div><dt>复制时间</dt><dd>{new Date(item.createdAt).toLocaleString()}</dd></div></dl>
      </section>

      <section className="fields-section">
        <div className="section-heading"><h2>字段与变量</h2><span>使用 {'{{name}}'} 定义变量</span></div>
        <div className="field-list">
          {item.fields.map((field) => {
            const isUnique = item.uniqueFieldKeys?.includes(field.key) ?? false;
            const canBeUnique = typeof field.value === 'string';
            return (
              <article className="field-card" key={field.key}>
                <div className="field-card-head"><strong>{field.label || field.name || field.id || field.key}</strong><label className="unique-toggle"><input type="checkbox" checked={isUnique} disabled={!canBeUnique} onChange={(event) => void onUnique(field.key, event.target.checked)} />唯一字段</label></div>
                {typeof field.value === 'string' ? (
                  <textarea rows={field.value.length > 80 ? 3 : 1} value={values[field.key] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />
                ) : <div className="value-preview">{displayValue(field.value)}</div>}
                <small>{field.key} · {field.type}</small>
              </article>
            );
          })}
        </div>
        <button className="secondary-button full" onClick={saveFields}>保存字段模板</button>
      </section>

      <footer className="sticky-actions"><button className="primary-button" onClick={onPaste}>粘贴此表单</button><button className="text-button danger" onClick={() => { if (window.confirm(`确定删除“${item.name}”吗？`)) void onDelete(); }}>删除</button></footer>
    </>
  );
}
