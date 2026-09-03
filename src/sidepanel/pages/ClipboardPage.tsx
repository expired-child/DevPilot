import { useMemo, useState } from 'react';

import { searchHistory } from '../../modules/form-clipboard/clipboard-service';
import type { FormClipboardItem, FormClipboardState } from '../../modules/form-clipboard/clipboard-types';

interface Props {
  state: FormClipboardState;
  onCopy(): void;
  onPaste(item: FormClipboardItem): void;
  onDetail(item: FormClipboardItem): void;
  onClear(): Promise<void>;
}

const relativeTime = (timestamp: number): string => {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 2_880) return '昨天';
  return `${Math.floor(minutes / 1_440)} 天前`;
};

function HistoryItem({ item, current, onPaste, onDetail }: { item: FormClipboardItem; current: boolean; onPaste(): void; onDetail(): void }) {
  return (
    <article className="history-item" onClick={onDetail}>
      <div className="history-main">
        <div className="history-name">
          {item.pinned && <span title="已固定">◆</span>}
          {current && <span className="current-dot" title="当前剪贴板" />}
          <strong>{item.name}</strong>
        </div>
        <div className="meta">{item.fields.length} 个字段 · {relativeTime(item.updatedAt)}</div>
        <div className="host">{item.source.host}</div>
      </div>
      <button className="small-button" onClick={(event) => { event.stopPropagation(); onPaste(); }}>粘贴</button>
    </article>
  );
}

export function ClipboardPage({ state, onCopy, onPaste, onDetail, onClear }: Props) {
  const [query, setQuery] = useState('');
  const current = state.history.find((item) => item.id === state.currentId);
  const results = useMemo(() => searchHistory(state.history, query), [state.history, query]);

  return (
    <>
      <header className="brand-header">
        <div className="brand-mark">D</div>
        <div><h1>DevPilot</h1><p>Form Clipboard</p></div>
      </header>

      <section className="current-section">
        <span className="eyebrow">最近复制</span>
        {current ? (
          <div className="current-card">
            <div><h2>{current.name}</h2><p>{current.fields.length} 个字段 · {relativeTime(current.updatedAt)}</p></div>
            <button className="primary-button" onClick={() => onPaste(current)}>粘贴最近表单</button>
          </div>
        ) : (
          <div className="empty-card">还没有复制过表单</div>
        )}
        <button className="secondary-button full" onClick={onCopy}>复制当前表单</button>
      </section>

      <section className="history-section">
        <div className="section-heading"><h2>表单历史</h2><span>{state.history.length}</span></div>
        <label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、网站或字段" /></label>
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
