import { useMemo, useState } from 'react';

import { createDiff } from '../../modules/form-clipboard/diff-service';
import { collectVariables, renderTemplate } from '../../modules/form-clipboard/template-service';
import type { FieldAssignment, FieldMatch, FillReport, FormClipboardItem, FormValue } from '../../modules/form-clipboard/clipboard-types';
import { validateUniqueFields } from '../../modules/form-clipboard/validation-service';

interface Props {
  item: FormClipboardItem;
  matches: FieldMatch[];
  targetTitle?: string;
  onBack(): void;
  onConfirm(assignments: FieldAssignment[], unmatchedLabels: string[]): Promise<FillReport | null>;
}

const labels = { UNCHANGED: '未变化', CHANGED: '已修改', UNIQUE: '唯一字段', UNMATCHED: '未匹配' } as const;
const valueText = (value: FormValue): string => Array.isArray(value) ? value.join(', ') : String(value ?? '');

export function PastePreviewPage({ item, matches, targetTitle, onBack, onConfirm }: Props) {
  const variableNames = useMemo(() => collectVariables(item.fields.flatMap((field) => typeof field.value === 'string' ? [field.value] : [])), [item.fields]);
  const [variables, setVariables] = useState<Record<string, string>>(() => Object.fromEntries(variableNames.map((name) => [name, item.variables?.[name] ?? ''])));
  const [uniqueOverrides, setUniqueOverrides] = useState<Record<string, string>>({});
  const [viewAll, setViewAll] = useState(false);
  const [report, setReport] = useState<FillReport | null>(null);

  const rendered = useMemo(() => {
    const values: Record<string, FormValue> = {};
    const missing = new Set<string>();
    for (const field of item.fields) {
      if (typeof field.value !== 'string') {
        values[field.key] = field.value;
        continue;
      }
      const result = renderTemplate(field.value, variables);
      result.missing.forEach((name) => missing.add(name));
      values[field.key] = uniqueOverrides[field.key] ?? result.value;
    }
    return { values, missing: [...missing] };
  }, [item.fields, variables, uniqueOverrides]);

  const diffs = createDiff(matches, rendered.values, item.uniqueFieldKeys ?? []);
  const uniqueValidation = validateUniqueFields(
    diffs.filter((diff) => diff.status === 'UNIQUE' && diff.target).map((diff) => ({
      key: diff.source.key,
      label: diff.source.label || diff.source.name || diff.source.key,
      originalValue: diff.originalValue,
      nextValue: diff.nextValue,
    })),
  );
  const visible = viewAll ? diffs : diffs.filter((diff) => diff.status !== 'UNCHANGED');
  const counts = (status: keyof typeof labels): number => diffs.filter((diff) => diff.status === status).length;
  const canFill = diffs.some((diff) => diff.target) && rendered.missing.length === 0 && uniqueValidation.valid;

  const fill = async (): Promise<void> => {
    const assignments = diffs.flatMap<FieldAssignment>((diff) => diff.target ? [{
      targetKey: diff.target.key,
      targetSelector: diff.target.selector,
      label: diff.source.label || diff.source.name || diff.source.key,
      value: diff.nextValue,
    }] : []);
    const unmatched = diffs.filter((diff) => !diff.target).map((diff) => diff.source.label || diff.source.name || diff.source.key);
    setReport(await onConfirm(assignments, unmatched));
  };

  return (
    <>
      <header className="page-header"><button className="icon-button" onClick={onBack}>←</button><div><span className="eyebrow">粘贴前检查</span><h1>Paste Preview</h1></div></header>
      <section className="preview-summary"><div><span>目标页面</span><strong>{targetTitle || '当前页面'}</strong></div><div><span>来源</span><strong>{item.name}</strong></div></section>

      {variableNames.length > 0 && <section className="input-section"><h2>需要填写</h2>{variableNames.map((name) => <label className="field-label" key={name}>{name}<input value={variables[name]} onChange={(event) => setVariables((current) => ({ ...current, [name]: event.target.value }))} placeholder={`输入 ${name}`} /></label>)}</section>}

      {(item.uniqueFieldKeys?.length ?? 0) > 0 && <section className="input-section"><h2>唯一字段</h2>{item.uniqueFieldKeys?.map((key) => {
        const field = item.fields.find((entry) => entry.key === key);
        if (!field || typeof field.value !== 'string') return null;
        const base = renderTemplate(field.value, variables).value;
        return <label className="field-label" key={key}>{field.label || field.name || key}<input value={uniqueOverrides[key] ?? base} onChange={(event) => setUniqueOverrides((current) => ({ ...current, [key]: event.target.value }))} /><small>原值：{field.value}</small></label>;
      })}{uniqueValidation.errors.map((error) => <div className="inline-error" key={error}>{error}</div>)}</section>}

      <section className="diff-section">
        <div className="stats"><div><strong>{diffs.length - counts('UNMATCHED')}</strong><span>成功匹配</span></div><div><strong>{counts('CHANGED')}</strong><span>发生变化</span></div><div><strong>{counts('UNIQUE')}</strong><span>唯一字段</span></div><div><strong>{counts('UNMATCHED')}</strong><span>未匹配</span></div></div>
        <div className="section-heading"><h2>Diff</h2><button className="text-button" onClick={() => setViewAll((current) => !current)}>{viewAll ? '只看重点' : '查看全部字段'}</button></div>
        <div className="diff-list">{visible.map((diff) => <article className={`diff-row ${diff.status.toLowerCase()}`} key={diff.source.key}><div className="diff-head"><strong>{diff.source.label || diff.source.name || diff.source.key}</strong><span>{labels[diff.status]}</span></div><div className="diff-values"><del>{valueText(diff.originalValue)}</del><span>→</span><ins>{valueText(diff.nextValue)}</ins></div>{!diff.target && <small>未找到高置信度匹配，已跳过</small>}</article>)}{visible.length === 0 && <div className="empty-list">没有需要特别确认的字段，可查看全部字段。</div>}</div>
      </section>

      {rendered.missing.length > 0 && <div className="inline-error">请填写变量：{rendered.missing.join('、')}</div>}
      {report && <section className="result-card"><h2>填充完成</h2><p>成功 {report.success} · 跳过 {report.skipped} · 失败 {report.failed}</p>{report.issues.map((issue, index) => <div key={`${issue.label}-${index}`}><strong>{issue.label}</strong><span>{issue.reason}</span></div>)}</section>}
      <footer className="sticky-actions"><button className="primary-button" disabled={!canFill} onClick={() => void fill()}>确认填充</button><span className="safety-note">不会自动提交</span></footer>
    </>
  );
}
