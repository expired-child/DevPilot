import { BookmarkOrganizePage } from './BookmarkOrganizePage';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import {
  createBookmarkService,
  searchBookmarks,
  type BookmarkEntry,
} from '../../modules/bookmark-search/bookmark-service';
import { AppHeader } from '../components/AppHeader';
import { BackIcon, CloseIcon, OrganizeIcon, SearchIcon } from '../components/icons';

interface Props {
  focusToken: number;
  onBack(): void;
}

/** 导入或批量编辑会产生一连串事件；合并窗口内的变化只触发一次重载。 */
const REFRESH_DEBOUNCE_MS = 200;

/** 高亮搜索命中，保留原文大小写；没有关键字时原样返回。 */
const highlightMatch = (text: string, query: string): ReactNode => {
  const needle = query.trim();
  if (!needle) return text;
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const hit = haystack.indexOf(target, cursor);
    if (hit < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    if (hit > cursor) parts.push(text.slice(cursor, hit));
    parts.push(<mark key={`${hit}-${cursor}`}>{text.slice(hit, hit + needle.length)}</mark>);
    cursor = hit + needle.length;
  }
  return parts;
};

/** 结果项即 listbox 的 option：激活统一走输入框的 Enter，不在 option 里嵌按钮。 */
function BookmarkItem({ entry, active, query, onOpen }: { entry: BookmarkEntry; active: boolean; query: string; onOpen(): void }) {
  return (
    <div
      role="option"
      id={`bookmark-option-${entry.id}`}
      aria-selected={active}
      className={`history-item history-open bookmark-result${active ? ' active' : ''}`}
      onClick={onOpen}
    >
      <div className="history-name"><strong title={entry.title}>{highlightMatch(entry.title, query)}</strong></div>
      {entry.folderPath && <div className="meta" title={entry.folderPath}>{highlightMatch(entry.folderPath, query)}</div>}
      <div className="host" title={entry.url} dir="ltr">{highlightMatch(entry.url, query)}</div>
    </div>
  );
}

export function BookmarkSearchPage({ focusToken, onBack }: Props) {
  const [organizing, setOrganizing] = useState(false);
  const [organizeDirty, setOrganizeDirty] = useState(false);
  const organizeDirtyRef = useRef(false);
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

  /** 整理页有未应用的勾选或 AI 预览时，返回/关闭前先确认，避免一次误触丢掉操作。 */
  const leaveOrganize = (): void => {
    if (organizeDirty && !window.confirm('返回书签搜索会丢失当前勾选和 AI 预览，确定返回？')) return;
    setOrganizeDirty(false);
    setOrganizing(false);
  };

  const closeFromOrganize = (): void => {
    if (organizeDirty && !window.confirm('关闭侧栏会丢失当前勾选和 AI 预览，确定关闭？')) return;
    void closePanel();
  };

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (organizing || event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      void closePanel();
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [closePanel, organizing]);

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
    organizeDirtyRef.current = organizeDirty;
  }, [organizeDirty]);

  useEffect(() => {
    queueMicrotask(() => {
      // 快捷键再次唤起搜索时也会离开整理页，未应用的操作同样需要确认。
      if (organizeDirtyRef.current && !window.confirm('返回书签搜索会丢失当前勾选和 AI 预览，确定返回？')) return;
      setOrganizeDirty(false);
      setOrganizing(false);
    });
  }, [focusToken]);

  useEffect(() => {
    if (!organizing) inputRef.current?.focus();
  }, [organizing, focusToken]);

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

  if (organizing) return <>
    <header className="page-header">
      <button className="icon-button" onClick={leaveOrganize} aria-label="返回书签搜索"><BackIcon /></button>
      <div><h1>智能整理</h1></div>
      <button className="icon-button bookmark-close" aria-label="关闭书签搜索侧栏" onClick={closeFromOrganize}><CloseIcon /></button>
    </header>
    <BookmarkOrganizePage active onBack={leaveOrganize} onDirtyChange={setOrganizeDirty} />
  </>;

  return (
    <>
      <AppHeader
        active="bookmarks"
        onSelect={(module) => { if (module === 'forms') onBack(); }}
        onClose={() => void closePanel()}
        closeLabel="关闭书签搜索侧栏"
      />

      <section className="history-section">
        <div className="section-heading">
          <span className="section-heading-title"><h2>书签</h2><span className="section-count">{searching ? results.length : entries.length}</span></span>
          <button type="button" className="small-button organize-entry" aria-label="智能整理与自动分类" onClick={() => { setOrganizeDirty(false); setOrganizing(true); }}>
            <OrganizeIcon />
            <span>智能整理</span>
          </button>
        </div>
        <div className="search-box">
          <SearchIcon />
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
          {query && (
            <button
              type="button"
              className="search-clear"
              aria-label="清空书签搜索"
              onClick={() => {
                setQuery('');
                setActiveId(null);
                inputRef.current?.focus();
              }}
            >
              <CloseIcon />
            </button>
          )}
        </div>
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
                query={query}
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
