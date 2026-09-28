import { useMemo, useState } from 'react';

import { searchHistory } from '../../modules/form-clipboard/clipboard-service';
import type { FormClipboardItem, FormClipboardState, ReplacementRule } from '../../modules/form-clipboard/clipboard-types';
import { GlobalReplacementSettings } from './GlobalReplacementSettings';

interface Props {
  state: FormClipboardState;
  onCopy(): void;
  onPaste(item: FormClipboardItem): void;
  onDetail(item: FormClipboardItem): void;
  onBookmarks(): void;
  onClear(): Promise<void>;
  replacementPending: boolean;
  onReplacementToggle(enabled: boolean): Promise<void>;
  replacementDraft: ReplacementRule[] | null;
  replacementDraftConflict: boolean;
  onReplacementDraftChange(rules: ReplacementRule[] | null): void;
  onReplacementDraftRebase(): void;
  onSaveReplacementRules(rules: ReplacementRule[]): Promise<void>;
}

const relativeTime = (timestamp: number): string => {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 2_880) return '昨天';
  return `${Math.floor(minutes / 1_440)} 天前`;
};

const metaText = (item: FormClipboardItem): string => {
  const excludedCount = item.excludedFieldKeys?.length ?? 0;
  const parts = [`${item.fields.length} 个字段`];
  if (excludedCount > 0) {
    parts.push(`${item.fields.length - excludedCount} 项将粘贴`);
  }
  parts.push(relativeTime(item.updatedAt));
  return parts.join(' · ');
};

function HistoryItem({ item, current, onPaste, onDetail }: { item: FormClipboardItem; current: boolean; onPaste(): void; onDetail(): void }) {
  return (
    <article className="history-item">
      <button className="history-main history-open" onClick={onDetail} aria-label={`查看“${item.name}”详情`}>
        <div className="history-name">
          {item.pinned && <span title="已固定" aria-hidden="true">◆</span>}
          {current && <span className="current-dot" title="当前剪贴板" aria-hidden="true" />}
          <strong>{item.name}</strong>
        </div>
        <div className="meta">{metaText(item)}</div>
        <div className="host" title={item.source.title || item.source.url}>{item.source.title || item.source.host}</div>
      </button>
      <button className="small-button" onClick={onPaste} aria-label={`预览并填充“${item.name}”`}>预览</button>
    </article>
  );
}

export function ClipboardPage({ state, onCopy, onPaste, onDetail, onBookmarks, onClear, replacementPending, onReplacementToggle, replacementDraft, replacementDraftConflict, onReplacementDraftChange, onReplacementDraftRebase, onSaveReplacementRules }: Props) {
  const [query, setQuery] = useState('');
  const current = state.history.find((item) => item.id === state.currentId);
  const results = useMemo(() => searchHistory(state.history, query), [state.history, query]);

  return (
    <>
      <header className="brand-header">
        <div className="brand-mark">D</div>
        <div><h1>DevPilot</h1><p>表单剪贴板</p></div>
      </header>

      <button className="secondary-button full bookmark-entry" onClick={onBookmarks}>⌕ 书签搜索</button>

      <GlobalReplacementSettings
        settings={state.settings}
        togglePending={replacementPending}
        onToggle={onReplacementToggle}
        draft={replacementDraft}
        draftConflict={replacementDraftConflict}
        onDraftChange={onReplacementDraftChange}
        onDraftRebase={onReplacementDraftRebase}
        onSave={onSaveReplacementRules}
      />

      <section className="current-section">
        <span className="eyebrow">最近复制</span>
        {current ? (
          <div className="current-card">
            <div><h2>{current.name}</h2><p>{metaText(current)}</p><p className="host">来源：{current.source.title || current.source.host}</p><p className="field-summary">字段：{current.fields.slice(0, 3).map((field) => field.label || field.name || field.key).join('、')}{current.fields.length > 3 ? '等' : ''}</p></div>
            <button className="primary-button" onClick={() => onPaste(current)}>预览并填充最近表单</button>
          </div>
        ) : (
          <div className="empty-card">还没有复制过表单。先在网页中点击目标表单的输入框，再复制。</div>
        )}
        <button className="secondary-button full" onClick={onCopy}>复制当前表单</button>
        <p className="copy-hint">页面有多个表单时，请先点击要复制的表单。</p>
      </section>

      <section className="history-section">
        <div className="section-heading"><h2>表单历史</h2><span>{state.history.length}</span></div>
        <label className="search-box"><span aria-hidden="true">⌕</span><input aria-label="搜索表单历史" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、网站或字段" /></label>
        <div className="history-list">
          {results.map((item) => (
            <HistoryItem key={item.id} item={item} current={item.id === state.currentId} onPaste={() => onPaste(item)} onDetail={() => onDetail(item)} />
          ))}
          {results.length === 0 && <div className="empty-list">{query ? '没有匹配的记录' : '复制网页表单后会显示在这里'}</div>}
        </div>
        {state.history.length > 0 && (
          <button className="text-button danger" onClick={() => { if (window.confirm('确定清空所有表单剪贴板记录吗？')) void onClear(); }}>清空历史</button>
        )}
      </section>
    </>
  );
}
