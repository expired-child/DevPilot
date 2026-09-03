import { useMemo, useState } from 'react';

import { buildFillPlan } from '../../modules/form-clipboard/fill-plan-service';
import { collectVariables } from '../../modules/form-clipboard/template-service';
import type {
  FieldAssignment,
  FieldDiff,
  FillIssue,
  FillReport,
  FormClipboardItem,
  FormField,
  FormValue,
} from '../../modules/form-clipboard/clipboard-types';
import { validateUniqueFields } from '../../modules/form-clipboard/validation-service';

interface Props {
  item: FormClipboardItem;
  targetFields: FormField[];
  targetTitle?: string;
  onBack(): void;
  onConfirm(assignments: FieldAssignment[], skipped: FillIssue[]): Promise<FillReport | null>;
}

const labels = { UNCHANGED: '未变化', CHANGED: '已修改', UNIQUE: '唯一字段', UNMATCHED: '未匹配' } as const;
const valueText = (value: FormValue): string => Array.isArray(value) ? value.join(', ') : String(value ?? '');

export function PastePreviewPage({ item, targetFields, targetTitle, onBack, onConfirm }: Props) {
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set(item.excludedFieldKeys ?? []));
  const [viewAll, setViewAll] = useState(false);
  const [report, setReport] = useState<FillReport | null>(null);

  const variableNames = useMemo(
    () => collectVariables(item.fields.filter((field) => !excluded.has(field.key)).flatMap((field) => typeof field.value === 'string' ? [field.value] : [])),
    [item.fields, excluded],
  );
  const [variables, setVariables] = useState<Record<string, string>>(() => Object.fromEntries(variableNames.map((name) => [name, item.variables?.[name] ?? ''])));
  const [uniqueOverrides, setUniqueOverrides] = useState<Record<string, string>>({});

  const plan = useMemo(
    () => buildFillPlan(item, targetFields, { variables, overrides: uniqueOverrides, excludedKeys: excluded }),
    [item, targetFields, variables, uniqueOverrides, excluded],
  );
  const diffs = plan.diffs;
  const uniqueValidation = validateUniqueFields(
    diffs
      .filter((diff) => diff.status === 'UNIQUE' && diff.target && !excluded.has(diff.source.key))
      .map((diff) => ({
        key: diff.source.key,
        label: diff.source.label || diff.source.name || diff.source.key,
        originalValue: diff.originalValue,
        nextValue: diff.nextValue,
      })),
  );
  // 「只看重点」隐藏无变化字段，但被排除的字段始终可见，方便随时勾回来。
  const visible = viewAll ? diffs : diffs.filter((diff) => diff.status !== 'UNCHANGED' || excluded.has(diff.source.key));
  const counts = (status: keyof typeof labels): number => diffs.filter((diff) => diff.status === status).length;
  const pasteCount = plan.assignments.length;
  const canFill = pasteCount > 0 && plan.missingVariables.length === 0 && uniqueValidation.valid;

  const toggleField = (key: string, included: boolean): void => {
    setExcluded((current) => {
      const next = new Set(current);
      if (included) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };
  const selectAll = (): void => setExcluded(new Set());
  const selectRequiredOnly = (): void =>
    setExcluded(new Set(diffs.filter((diff) => diff.target && !diff.source.required).map((diff) => diff.source.key)));

  const fill = async (): Promise<void> => {
    setReport(await onConfirm(plan.assignments, plan.skipped));
  };

  const renderRow = (diff: FieldDiff) => {
    const rowExcluded = excluded.has(diff.source.key) || !diff.target;
    const statusText = !diff.target ? labels.UNMATCHED : rowExcluded ? '已排除' : labels[diff.status];
    return (
      <article className={`diff-row ${rowExcluded ? 'excluded' : diff.status.toLowerCase()}`} key={diff.source.key}>
        <div className="diff-head">
          <strong>{diff.source.label || diff.source.name || diff.source.key}</strong>
          <span className="head-meta">
            {diff.target && <label className="include-toggle"><input type="checkbox" checked={!rowExcluded} onChange={(event) => toggleField(diff.source.key, event.target.checked)} />粘贴</label>}
            <span>{statusText}</span>
          </span>
        </div>
        <div className="diff-values"><del>{valueText(diff.originalValue)}</del><span>→</span><ins>{valueText(diff.nextValue)}</ins></div>
        {!diff.target && <small>未找到高置信度匹配，已跳过</small>}
      </article>
    );
  };

  return (
    <>
      <header className="page-header"><button className="icon-button" onClick={onBack}>←</button><div><span className="eyebrow">粘贴前检查</span><h1>Paste Preview</h1></div></header>
      <section className="preview-summary"><div><span>目标页面</span><strong>{targetTitle || '当前页面'}</strong></div><div><span>来源</span><strong>{item.name}</strong></div></section>

      {variableNames.length > 0 && <section className="input-section"><h2>需要填写</h2>{variableNames.map((name) => <label className="field-label" key={name}>{name}<input value={variables[name] ?? ''} onChange={(event) => setVariables((current) => ({ ...current, [name]: event.target.value }))} placeholder={`输入 ${name}`} /></label>)}</section>}

      {(item.uniqueFieldKeys?.length ?? 0) > 0 && <section className="input-section"><h2>唯一字段</h2>{item.uniqueFieldKeys?.map((key) => {
        const field = item.fields.find((entry) => entry.key === key);
        if (!field || typeof field.value !== 'string') return null;
        const isExcluded = excluded.has(key);
        return <label className={`field-label${isExcluded ? ' excluded' : ''}`} key={key}>{field.label || field.name || key}<input value={uniqueOverrides[key] ?? field.value} disabled={isExcluded} onChange={(event) => setUniqueOverrides((current) => ({ ...current, [key]: event.target.value }))} /><small>原值：{field.value}{isExcluded ? ' · 已排除，不参与粘贴' : ''}</small></label>;
      })}{uniqueValidation.errors.map((error) => <div className="inline-error" key={error}>{error}</div>)}</section>}

      <section className="diff-section">
        <div className="stats">
          <div><strong>{pasteCount}</strong><span>将粘贴</span></div>
          <div><strong>{diffs.length - counts('UNMATCHED')}</strong><span>成功匹配</span></div>
          <div><strong>{counts('CHANGED')}</strong><span>发生变化</span></div>
          <div><strong>{counts('UNIQUE')}</strong><span>唯一字段</span></div>
          <div><strong>{counts('UNMATCHED')}</strong><span>未匹配</span></div>
        </div>
        <div className="section-heading"><h2>Diff</h2><span>{excluded.size > 0 ? `${excluded.size} 个字段不粘贴` : '全部字段参与粘贴'}</span></div>
        <div className="include-bar">
          <button className="text-button" onClick={selectAll}>全选</button>
          <button className="text-button" onClick={selectRequiredOnly}>只填必填</button>
          <button className="text-button" onClick={() => setViewAll((current) => !current)}>{viewAll ? '只看重点' : '查看全部字段'}</button>
        </div>
        <div className="diff-list">{visible.map(renderRow)}{visible.length === 0 && <div className="empty-list">没有需要特别确认的字段，可查看全部字段。</div>}</div>
      </section>

      {plan.missingVariables.length > 0 && <div className="inline-error">请填写变量：{plan.missingVariables.join('、')}</div>}
      {report && <section className="result-card"><h2>填充完成</h2><p>成功 {report.success} · 跳过 {report.skipped} · 失败 {report.failed}</p>{report.issues.map((issue, index) => <div key={`${issue.label}-${index}`}><strong>{issue.label}</strong><span>{issue.reason}</span></div>)}</section>}
      <footer className="sticky-actions"><button className="primary-button" disabled={!canFill} onClick={() => void fill()}>确认填充（{pasteCount} 个字段）</button><span className="safety-note">不会自动提交</span></footer>
    </>
  );
}
