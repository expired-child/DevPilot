import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import {
  loadBookmarks,
  searchBookmarks,
  watchBookmarkChanges,
  type BookmarkEntry,
} from '../../modules/bookmark-search/bookmark-service';

interface Props {
  focusToken: number;
  onBack(): void;
}

function BookmarkItem({ entry, active, onOpen }: { entry: BookmarkEntry; active: boolean; onOpen(): void }) {
  return (
    <article className={`history-item${active ? ' active' : ''}`}>
      <button className="history-main history-open" onClick={onOpen} aria-label={`在新标签页打开“${entry.title}”`}>
        <div className="history-name"><strong>{entry.title}</strong></div>
        {entry.folderPath && <div className="meta">{entry.folderPath}</div>}
        <div className="host" title={entry.url}>{entry.url}</div>
      </button>
    </article>
  );
}

export function BookmarkSearchPage({ focusToken, onBack }: Props) {
  const [entries, setEntries] = useState<BookmarkEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [opening, setOpening] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const searching = query.trim().length > 0;
  const results = useMemo(() => searchBookmarks(entries, query), [entries, query]);

  const closePanel = useCallback(async (windowId?: number): Promise<boolean> => {
    try {
      const targetWindowId = windowId ?? (await chrome.windows.getCurrent()).id;
      if (targetWindowId === undefined) throw new Error('未找到当前窗口');
      await chrome.sidePanel.close({ windowId: targetWindowId });
      return true;
    } catch (closeError) {
      setError(closeError instanceof Error ? `关闭侧栏失败：${closeError.message}` : '关闭侧栏失败');
      return false;
    }
  }, []);

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      void closePanel();
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [closePanel]);

  useEffect(() => {
    const unwatch = watchBookmarkChanges();
    void loadBookmarks()
      .then((loaded) => {
        setEntries(loaded);
        setError(null);
        setLoading(false);
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : '书签加载失败');
        setLoading(false);
      });
    return unwatch;
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    document.querySelector('.history-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, results]);

  const openNewTab = async (entry: BookmarkEntry): Promise<void> => {
    if (opening) return;
    setOpening(true);
    try {
      const tab = await chrome.tabs.create({ url: entry.url, active: true });
      if (!await closePanel(tab.windowId)) setOpening(false);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : '打开书签失败');
      setOpening(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => results.length ? Math.min(index + 1, results.length - 1) : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      const entry = results[activeIndex];
      if (entry) void openNewTab(entry);
    }
  };

  return (
    <>
      <header className="page-header">
        <button className="icon-button" onClick={onBack} aria-label="返回表单历史">←</button>
        <div><span className="eyebrow">书签搜索</span><h1>浏览器书签</h1></div>
        <button className="icon-button bookmark-close" onClick={() => void closePanel()} aria-label="关闭书签搜索侧栏" title="关闭侧栏（Esc）">×</button>
      </header>

      <section className="history-section">
        <div className="section-heading"><h2>书签</h2><span>{searching ? results.length : entries.length}</span></div>
        <label className="search-box">
          <span aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            aria-label="搜索浏览器书签"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="搜索书签名称、网址或文件夹"
          />
        </label>
        {error && <div className="inline-error">{error}</div>}
        <div className="history-list">
          {loading ? (
            <div className="empty-list">正在加载书签…</div>
          ) : !searching ? (
            <div className="empty-list">输入关键字搜索书签</div>
          ) : results.length === 0 ? (
            <div className="empty-list">没有匹配的书签</div>
          ) : (
            results.map((entry, index) => (
              <BookmarkItem
                key={entry.id}
                entry={entry}
                active={index === activeIndex}
                onOpen={() => void openNewTab(entry)}
              />
            ))
          )}
        </div>
        <p className="copy-hint">↑↓ 选择 · Enter 新标签页打开 · Esc 关闭侧栏</p>
      </section>
    </>
  );
}
