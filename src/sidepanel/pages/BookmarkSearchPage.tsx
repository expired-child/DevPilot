import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import {
  createBookmarkService,
  searchBookmarks,
  type BookmarkEntry,
} from '../../modules/bookmark-search/bookmark-service';

interface Props {
  focusToken: number;
  onBack(): void;
}

/** 导入或批量编辑会产生一连串事件；合并窗口内的变化只触发一次重载。 */
const REFRESH_DEBOUNCE_MS = 200;

/** 结果项即 listbox 的 option：激活统一走输入框的 Enter，不在 option 里嵌按钮。 */
function BookmarkItem({ entry, active, onOpen }: { entry: BookmarkEntry; active: boolean; onOpen(): void }) {
  return (
    <div
      role="option"
      id={`bookmark-option-${entry.id}`}
      aria-selected={active}
      className={`history-item history-open${active ? ' active' : ''}`}
      onClick={onOpen}
    >
      <div className="history-name"><strong>{entry.title}</strong></div>
      {entry.folderPath && <div className="meta">{entry.folderPath}</div>}
      <div className="host" title={entry.url}>{entry.url}</div>
    </div>
  );
}

export function BookmarkSearchPage({ focusToken, onBack }: Props) {
  const [entries, setEntries] = useState<BookmarkEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const reloadTimer = useRef<number | undefined>(undefined);
  const hasLoadedRef = useRef(false);
  const [store] = useState(createBookmarkService);

  const searching = query.trim().length > 0;
  const results = useMemo(() => searchBookmarks(entries, query), [entries, query]);
  // 按书签 ID 保留选中：条目被删或不再匹配时回落到第一项，Enter 不会打开旧条目。
  const matchedIndex = results.findIndex((entry) => entry.id === activeId);
  const activeIndex = matchedIndex >= 0 ? Math.min(matchedIndex, results.length - 1) : 0;
  const activeEntry = results[activeIndex] as BookmarkEntry | undefined;

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    try {
      const loaded = await store.loadBookmarks();
      if (seq !== requestSeq.current) return;
      setEntries(loaded);
      hasLoadedRef.current = true;
      setError(null);
      setRefreshError(null);
    } catch (cause) {
      // 刷新失败保留旧结果并提示可重试；只有从未加载成功才算阻断错误。
      if (seq !== requestSeq.current) return;
      const message = cause instanceof Error ? cause.message : '书签加载失败';
      if (hasLoadedRef.current) setRefreshError(message);
      else setError(message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [store]);

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
    let disposed = false;
    const unwatch = store.watchBookmarkChanges(() => {
      window.clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(() => { void refresh(); }, REFRESH_DEBOUNCE_MS);
    });
    queueMicrotask(() => { if (!disposed) void refresh(); });
    return () => {
      disposed = true;
      requestSeq.current += 1;
      unwatch();
      window.clearTimeout(reloadTimer.current);
      store.dispose();
    };
  }, [refresh, store]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    document.querySelector('.history-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [activeId, results]);

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
    // 输入法组合输入期间不触发选择与激活。
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveId(results.length ? (results[Math.min(activeIndex + 1, results.length - 1)]?.id ?? null) : null);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveId(results[Math.max(activeIndex - 1, 0)]?.id ?? null);
    } else if (event.key === 'Enter') {
      if (activeEntry) void openNewTab(activeEntry);
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
            role="combobox"
            aria-label="搜索浏览器书签"
            aria-autocomplete="list"
            aria-expanded={searching && !loading && results.length > 0}
            aria-controls={results.length > 0 ? 'bookmark-listbox' : undefined}
            aria-activedescendant={activeEntry ? `bookmark-option-${activeEntry.id}` : undefined}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveId(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="搜索书签名称、网址或文件夹"
          />
        </label>
        <p className="visually-hidden" role="status">{searching ? `找到 ${results.length} 个书签` : ''}</p>
        {error && (
          <div className="inline-error" role="alert">{error}
            <button className="text-button" onClick={() => void refresh()}>重试</button>
          </div>
        )}
        {refreshError && (
          <div className="inline-error" role="alert">书签更新失败，当前结果可能过期。
            <button className="text-button" onClick={() => void refresh()}>重试</button>
          </div>
        )}
        <div
          className="history-list"
          id="bookmark-listbox"
          role={results.length > 0 ? 'listbox' : undefined}
          aria-label={results.length > 0 ? '书签结果' : undefined}
        >
          {loading ? (
            <div className="empty-list">正在加载书签…</div>
          ) : !searching ? (
            <div className="empty-list">输入关键字搜索书签</div>
          ) : results.length === 0 ? (
            <div className="empty-list">没有匹配的书签，试试名称、网址或文件夹中的其他关键词。</div>
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
