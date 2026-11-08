import { useMemo, useRef, useState } from 'react';

import { searchHistory } from '../../modules/form-clipboard/clipboard-service';
import type { FormClipboardItem, FormClipboardState, ReplacementRule } from '../../modules/form-clipboard/clipboard-types';
import { AppHeader } from '../components/AppHeader';
import { CloseIcon, PinIcon, SearchIcon } from '../components/icons';
import { GlobalReplacementSettings } from './GlobalReplacementSettings';

interface Props {
  state: FormClipboardState;
  busyAction: 'copy' | 'paste' | null;
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

function HistoryItem({ item, current, busy, onPaste, onDetail }: { item: FormClipboardItem; current: boolean; busy: boolean; onPaste(): void; onDetail(): void }) {
  return (
    <article className={`history-item${current ? ' current' : ''}`}>
      <button className="history-main history-open" onClick={onPaste} disabled={busy} aria-label={`预览并填充「${item.name}」`}>
        <div className="history-name">
          {item.pinned && <PinIcon className="pinned-mark" role="img" aria-label="已固定" aria-hidden={false} />}
          {current && <span className="current-badge">当前</span>}
          <strong title={item.name}>{item.name}</strong>
          <span className="history-fill-hint" aria-hidden="true">填充</span>
        </div>
        <div className="meta">{metaText(item)}</div>
        <div className="host" title={item.source.title || item.source.url}>{item.source.title || item.source.host}</div>
      </button>
      <button className="text-button history-detail" onClick={onDetail} disabled={busy} aria-label={`查看「${item.name}」详情`}>详情</button>
    </article>
  );
}

export function ClipboardPage({ state, busyAction, onCopy, onPaste, onDetail, onBookmarks, onClear, replacementPending, onReplacementToggle, replacementDraft, replacementDraftConflict, onReplacementDraftChange, onReplacementDraftRebase, onSaveReplacementRules }: Props) {
  const [query, setQuery] = useState('');
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const current = state.history.find((item) => item.id === state.currentId);
  const results = useMemo(() => searchHistory(state.history, query), [state.history, query]);
  const searching = query.trim().length > 0;
  // 当前记录已在「最近复制」中完整展示，历史列表只在搜索时包含它，避免同屏重复。
  const shownHistory = searching ? results : results.filter((item) => item.id !== state.currentId);
  const hasArchive = state.history.some((item) => item.id !== state.currentId);
  const replacementEnabled = state.settings.replacementEnabled === true;
  const busy = busyAction !== null;

  const clearHistory = async (): Promise<void> => {
    setClearing(true);
    try {
      await onClear();
      setConfirmClear(false);
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <AppHeader
        active="forms"
        onSelect={(module) => { if (module === 'bookmarks') onBookmarks(); }}
      />

      <section className="quick-actions" aria-label="常用操作">
        <div className="section-heading">
          <h2>最近复制</h2>
          {current && (
            <button type="button" className="small-button" disabled={busy} onClick={onCopy}>
              {busyAction === 'copy' ? '正在扫描页面…' : '复制当前表单'}
            </button>
          )}
        </div>
        {current ? (
          <div className="recent-card">
            <div className="recent-title">
              {current.pinned && <PinIcon className="pinned-mark" role="img" aria-label="已固定" aria-hidden={false} />}
              <h3 title={current.name}>{current.name}</h3>
            </div>
            <p className="meta">{metaText(current)}</p>
            <p className="host" title={current.source.title || current.source.url}>来源：{current.source.title || current.source.host}</p>
            <p className="field-summary">字段：{current.fields.slice(0, 3).map((field) => field.label || field.name || field.key).join('、')}{current.fields.length > 3 ? '等' : ''}</p>
            <div className="action-row">
              <button className="primary-button" disabled={busy} onClick={() => onPaste(current)} aria-label={`预览并填充「${current.name}」`}>{busyAction === 'paste' ? '正在扫描目标页…' : '填充到当前页'}</button>
              <button className="text-button" disabled={busy} onClick={() => onDetail(current)} aria-label={`查看「${current.name}」详情`}>详情</button>
            </div>
          </div>
        ) : (
          <div className="empty-card">
            <h3>还没有复制过表单</h3>
            <p>先在网页中点击目标表单的输入框，再复制到 DevPilot。</p>
            <button className="primary-button" disabled={busy} onClick={onCopy}>{busyAction === 'copy' ? '正在扫描页面…' : '复制当前表单'}</button>
          </div>
        )}
        <p className="copy-hint">复制或填充时，如果页面有多个表单，会让你先选择目标。</p>
      </section>

      {(hasArchive || searching) && (
        <section className="history-section">
          <div className="section-heading"><h2>表单历史</h2><span className="section-count">{shownHistory.length}</span></div>
          {(hasArchive || searching) && (
            <div className="search-box">
              <SearchIcon />
              <input
                ref={searchRef}
                aria-label="搜索表单历史"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称、网站或字段"
              />
              {query && (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="清空表单历史搜索"
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                >
                  <CloseIcon />
                </button>
              )}
            </div>
          )}
          <div className="history-list">
            {shownHistory.map((item) => (
              <HistoryItem key={item.id} item={item} current={item.id === state.currentId} busy={busy} onPaste={() => onPaste(item)} onDetail={() => onDetail(item)} />
            ))}
            {shownHistory.length === 0 && <div className="empty-list">没有匹配的记录</div>}
          </div>
          {confirmClear ? (
            <div className="inline-confirm" role="alert">
              <span>清空全部 {state.history.length} 条记录？</span>
              <button className="text-button danger" disabled={clearing} onClick={() => void clearHistory()}>{clearing ? '正在清空…' : '确认清空'}</button>
              <button className="text-button" disabled={clearing} onClick={() => setConfirmClear(false)}>取消</button>
            </div>
          ) : (
            <button className="text-button danger" onClick={() => setConfirmClear(true)}>清空历史</button>
          )}
        </section>
      )}

      <details className="advanced-panel">
        <summary>
          <span>高级设置</span>
          <span className="advanced-summary">全局输入值替换 · {replacementEnabled ? '已开启' : '已关闭'}</span>
        </summary>
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
      </details>
    </>
  );
}
