import { useEffect, useMemo, useRef, useState } from 'react';

import { buildFillPlan } from '../../modules/form-clipboard/fill-plan-service';
import { collectVariables } from '../../modules/form-clipboard/template-service';
import type {
  FieldAssignment,
  FieldDiff,
  FillIssue,
  FillReport,
  FormClipboardItem,
  FormClipboardSettings,
  FormField,
  FormValue,
} from '../../modules/form-clipboard/clipboard-types';
import { validateUniqueFields } from '../../modules/form-clipboard/validation-service';

interface Props {
  item: FormClipboardItem;
  settings: FormClipboardSettings;
  replacementPending: boolean;
  onReplacementToggle(enabled: boolean): Promise<void>;
  targetFields: FormField[];
  targetTitle?: string;
  onBack(): void;
  onRefresh(): Promise<void>;
  onConfirm(assignments: FieldAssignment[], skipped: FillIssue[]): Promise<FillReport>;
}

const labels = { UNCHANGED: '值相同', CHANGED: '值将改变', UNIQUE: '唯一字段', UNMATCHED: '未匹配' } as const;
const valueText = (value: FormValue): string => Array.isArray(value) ? value.join(', ') : String(value ?? '');

export function PastePreviewPage({ item, settings, replacementPending, onReplacementToggle, targetFields, targetTitle, onBack, onRefresh, onConfirm }: Props) {
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set(item.excludedFieldKeys ?? []));
  const [viewAll, setViewAll] = useState(false);
  const [report, setReport] = useState<FillReport | null>(null);
  const [filling, setFilling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const fillingRef = useRef(false);
  const refreshingRef = useRef(false);
  const resultRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (report) {
      resultRef.current?.scrollIntoView({ block: 'start' });
      resultRef.current?.focus();
    }
  }, [report]);

  const variableNames = useMemo(
    () => collectVariables(item.fields.filter((field) => !excluded.has(field.key)).flatMap((field) => typeof field.value === 'string' ? [field.value] : [])),
    [item.fields, excluded],
  );
  const [variables, setVariables] = useState<Record<string, string>>(() => Object.fromEntries(variableNames.map((name) => [name, item.variables?.[name] ?? ''])));
  const [uniqueOverrides, setUniqueOverrides] = useState<Record<string, string>>({});

  const plan = useMemo(
    () => buildFillPlan(item, targetFields, { variables, overrides: uniqueOverrides, excludedKeys: excluded, settings }),
    [item, targetFields, variables, uniqueOverrides, excluded, settings],
  );
  const diffs = plan.diffs;
  const assignmentKeys = new Set(plan.assignments.map((assignment) => assignment.targetKey));
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
  // 默认展示会改变目标值、无法填写和被排除的字段；值相同的可在「查看全部」中检查。
  const visible = viewAll ? diffs : diffs.filter((diff) =>
    !diff.target || !assignmentKeys.has(diff.target.key) || diff.status !== 'UNCHANGED',
  );
  const pasteCount = plan.assignments.length;
  const changedCount = diffs.filter((diff) =>
    diff.target && assignmentKeys.has(diff.target.key) && JSON.stringify(diff.target.value) !== JSON.stringify(diff.nextValue),
  ).length;
  const skippedCount = diffs.length - pasteCount;
  const canFill = pasteCount > 0 && plan.missingVariables.length === 0 && uniqueValidation.valid && !replacementPending && !filling && !refreshing && !submissionError && !report;
  const blockingReason = pasteCount === 0
    ? '没有可粘贴的字段，请检查匹配结果和排除设置。'
    : plan.missingVariables.length > 0
      ? `请先填写变量：${plan.missingVariables.join('、')}`
      : !uniqueValidation.valid ? '请先修改唯一字段。' : null;

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
    setExcluded(new Set(diffs.filter((diff) => diff.target && !diff.target.required).map((diff) => diff.source.key)));

  const refresh = async (): Promise<void> => {
    if (refreshingRef.current || fillingRef.current || report) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await onRefresh();
      setSubmissionError(null);
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : '重新扫描失败，请重试。');
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  const fill = async (): Promise<void> => {
    if (fillingRef.current || !canFill) return;
    fillingRef.current = true;
    setFilling(true);
    setSubmissionError(null);
    try {
      setReport(await onConfirm(plan.assignments, plan.skipped));
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : '填充失败，请重新预览。');
    } finally {
      fillingRef.current = false;
      setFilling(false);
    }
  };

  const renderRow = (diff: FieldDiff) => {
    const rowExcluded = excluded.has(diff.source.key);
    const willFill = Boolean(diff.target && assignmentKeys.has(diff.target.key));
    const statusText = !diff.target ? labels.UNMATCHED : rowExcluded ? '已排除' : !willFill ? '已跳过' : labels[diff.status];
    return (
      <article className={`diff-row ${rowExcluded ? 'excluded' : diff.status.toLowerCase()}`} key={diff.source.key}>
        <div className="diff-head">
          <strong>{diff.source.label || diff.source.name || diff.source.key}</strong>
          <span className="head-meta">
            {diff.target && <label className="include-toggle"><input type="checkbox" checked={!rowExcluded} disabled={Boolean(report) || filling || refreshing} onChange={(event) => toggleField(diff.source.key, event.target.checked)} />粘贴</label>}
            <span>{statusText}</span>
          </span>
        </div>
        <div className="diff-values">
          <div><span>目标当前值</span><strong>{diff.target ? valueText(diff.target.value) || '（空）' : '无匹配字段'}</strong></div>
          <span aria-hidden="true">→</span>
          <div><span>{willFill ? '将填入' : '源记录'}</span><strong>{valueText(diff.nextValue) || '（空）'}</strong></div>
        </div>
        {!diff.target && <small>未找到高置信度匹配，已跳过</small>}
      </article>
    );
  };

  return (
    <>
      <header className="page-header"><button className="icon-button" onClick={onBack} aria-label="返回表单历史">←</button><div><span className="eyebrow">粘贴前检查</span><h1>粘贴预览</h1></div></header>
      <section className="preview-summary"><div><span>目标页面</span><strong>{targetTitle || '当前页面'}</strong></div><div><span>来源</span><strong>{item.name}</strong></div></section>
      {!report && <button className="text-button refresh-preview" disabled={filling || refreshing} onClick={() => void refresh()}>{refreshing ? '正在扫描…' : '重新扫描当前页'}</button>}
      <section className="input-section"><label className="replacement-toggle"><input type="checkbox" role="switch" aria-label="启用输入值替换" checked={settings.replacementEnabled === true} disabled={replacementPending || filling || refreshing || Boolean(report)} onChange={(event) => void onReplacementToggle(event.target.checked)} />输入值替换：{settings.replacementEnabled ? '已开启' : '已关闭'}</label><p className="replacement-help">此开关也影响快捷键粘贴；关闭后不执行全局或字段替换。</p></section>

      {variableNames.length > 0 && <section className="input-section"><h2>需要填写</h2>{variableNames.map((name) => <label className="field-label" key={name}>{name}<input value={variables[name] ?? ''} disabled={Boolean(report) || filling || refreshing} onChange={(event) => setVariables((current) => ({ ...current, [name]: event.target.value }))} placeholder={`输入 ${name}`} /></label>)}</section>}

      {(item.uniqueFieldKeys?.length ?? 0) > 0 && <section className="input-section"><h2>唯一字段</h2>{item.uniqueFieldKeys?.map((key) => {
        const field = item.fields.find((entry) => entry.key === key);
        if (!field || typeof field.value !== 'string') return null;
        const isExcluded = excluded.has(key);
        return <label className={`field-label${isExcluded ? ' excluded' : ''}`} key={key}>{field.label || field.name || key}<input value={uniqueOverrides[key] ?? valueText(diffs.find((diff) => diff.source.key === key)?.nextValue ?? field.value)} disabled={isExcluded || Boolean(report) || filling || refreshing} onChange={(event) => setUniqueOverrides((current) => ({ ...current, [key]: event.target.value }))} /><small>原值：{field.value}{isExcluded ? ' · 已排除，不参与粘贴' : ''}</small></label>;
      })}{uniqueValidation.errors.map((error) => <div className="inline-error" key={error}>{error}</div>)}</section>}

      <section className="diff-section">
        <div className="stats">
          <div><strong>{pasteCount}</strong><span>将粘贴</span></div>
          <div><strong>{changedCount}</strong><span>值将改变</span></div>
          <div><strong>{skippedCount}</strong><span>不会粘贴</span></div>
        </div>
        <div className="section-heading"><h2>字段对照</h2><span>{excluded.size > 0 ? `${excluded.size} 个字段已排除` : '对照目标页面当前值'}</span></div>
        <div className="include-bar">
          <button className="text-button" disabled={Boolean(report) || filling || refreshing} onClick={selectAll}>全选</button>
          <button className="text-button" disabled={Boolean(report) || filling || refreshing} onClick={selectRequiredOnly}>只填目标页必填</button>
          <button className="text-button" onClick={() => setViewAll((current) => !current)}>{viewAll ? '只看重点' : '查看全部字段'}</button>
        </div>
        <div className="diff-list">{visible.map(renderRow)}{visible.length === 0 && <div className="empty-list">没有需要特别确认的字段，可查看全部字段。</div>}</div>
      </section>

      {plan.missingVariables.length > 0 && <div className="inline-error">请填写变量：{plan.missingVariables.join('、')}</div>}
      {report && <section className="result-card" ref={resultRef} tabIndex={-1}><h2>填充完成</h2><p>成功 {report.success} · 跳过 {report.skipped} · 失败 {report.failed}</p>{report.issues.map((issue, index) => <div key={`${issue.label}-${index}`}><strong>{issue.label}</strong><span>{issue.reason}</span></div>)}<p>再次填充前，请返回历史并重新预览当前页面。</p></section>}
      <footer className="sticky-actions">
        {submissionError && <div className="inline-error" role="alert">{submissionError}</div>}
        {!report && blockingReason && <div className="blocking-note" role="status">{blockingReason}</div>}
        {report ? <button className="primary-button" onClick={onBack}>返回表单历史</button> : <button className="primary-button" disabled={!canFill} onClick={() => void fill()}>{filling ? '正在填充…' : `确认填充（${pasteCount} 个字段）`}</button>}
        <span className="safety-note">不会自动提交</span>
      </footer>
    </>
  );
}
