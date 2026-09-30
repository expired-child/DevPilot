import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import {
  createBookmarkService,
  searchBookmarks,
  type BookmarkEntry,
} from '../../modules/bookmark-search/bookmark-service';
import {
  classifyBookmark,
  suggestedTargetPath,
  type BookmarkEnvironment,
  type BookmarkPurpose,
} from '../../modules/bookmark-organizer/bookmark-classifier';
import {
  ChromeOrganizerRepository,
  ORGANIZER_STORAGE_KEY,
  type OrganizerState,
} from '../../modules/bookmark-organizer/bookmark-organizer-repository';
import { urlFingerprint } from '../../modules/bookmark-organizer/bookmark-tree';
import { PURPOSE_LABELS } from '../../modules/bookmark-organizer/bookmark-rules';
import { sendBookmarkCommand } from '../../shared/messaging/bookmark-commands';
import { BookmarkOrganizePage } from './BookmarkOrganizePage';

export type BookmarkPageMode = 'search' | 'browse' | 'organize';

export interface BookmarkBrowseFilters {
  purpose: BookmarkPurpose | 'all';
  project: string | 'all';
  environment: BookmarkEnvironment | 'all';
}

/** 由 App 持有的书签页状态：返回表单历史再回来时保留查询、模式与筛选。 */
export interface BookmarkUiState {
  mode: BookmarkPageMode;
  query: string;
  filters: BookmarkBrowseFilters;
}

export const defaultBookmarkUiState = (): BookmarkUiState => ({
  mode: 'search',
  query: '',
  filters: { purpose: 'all', project: 'all', environment: 'all' },
});

interface Props {
  focusToken: number;
  onBack(): void;
  ui?: BookmarkUiState;
  onUiChange?(ui: BookmarkUiState): void;
}

/** 导入或批量编辑会产生一连串事件；合并窗口内的变化只触发一次重载。 */
const REFRESH_DEBOUNCE_MS = 200;

const PURPOSE_ORDER: Array<BookmarkPurpose | 'unknown'> = [
  'business', 'devops', 'monitoring', 'design', 'ai', 'network', 'unknown',
];

const purposeLabel = (purpose: BookmarkPurpose | 'unknown'): string =>
  purpose === 'unknown' ? '待确认' : PURPOSE_LABELS[purpose];

interface ClassifiedEntry {
  entry: BookmarkEntry;
  purpose: BookmarkPurpose | 'unknown';
  project: string;
  environment: BookmarkEnvironment;
  verdict: 'certain' | 'review' | 'conflict';
}

/** 浏览分组键：只有确定项才进入具体用途组，待确认与冲突集中显示。 */
const browseGroupKey = (item: ClassifiedEntry): BookmarkPurpose | 'unknown' =>
  item.verdict === 'certain' ? item.purpose : 'unknown';

/** 结果项即 listbox 的 option：激活统一走输入框的 Enter，不在 option 里嵌按钮。 */
function BookmarkItem({ entry, active, onOpen }: { entry: BookmarkEntry; active: boolean; onOpen(): void }) {
  return (
    <div
      role="option"
      id={`bookmark-option-${entry.id}`}
      aria-selected={active}
      className={`history-item history-open bookmark-result${active ? ' active' : ''}`}
      onClick={onOpen}
    >
      <div className="history-name"><strong>{entry.title}</strong></div>
      {entry.folderPath && <div className="meta">{entry.folderPath}</div>}
      <div className="host" title={entry.url}>{entry.url}</div>
    </div>
  );
}

export function BookmarkSearchPage({ focusToken, onBack, ui: uiProp, onUiChange }: Props) {
  const [fallbackUi, setFallbackUi] = useState<BookmarkUiState>(defaultBookmarkUiState);
  const ui = uiProp ?? fallbackUi;
  const updateUi = useCallback((patch: Partial<BookmarkUiState>): void => {
    const next = { ...ui, ...patch };
    if (onUiChange) onUiChange(next);
    else setFallbackUi(next);
  }, [ui, onUiChange]);

  const mode = ui.mode;
  const query = ui.query;
  const filters = ui.filters;
  const setQuery = (value: string): void => updateUi({ query: value });
  const setFilters = (patch: Partial<BookmarkBrowseFilters>): void => updateUi({ filters: { ...filters, ...patch } });

  const [entries, setEntries] = useState<BookmarkEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [organizerState, setOrganizerState] = useState<OrganizerState | null>(null);
  const [organizerError, setOrganizerError] = useState<string | null>(null);
  const [savePage, setSavePage] = useState<{ title: string; url: string; targetPath: string } | null>(null);
  const [recommendingPage, setRecommendingPage] = useState(false);
  const [savingPage, setSavingPage] = useState(false);
  const saveRequestSeq = useRef(0);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const reloadTimer = useRef<number | undefined>(undefined);
  const hasLoadedRef = useRef(false);
  const [store] = useState(createBookmarkService);
  const [repo] = useState(() => new ChromeOrganizerRepository());

  useEffect(() => () => { saveRequestSeq.current += 1; }, []);

  const searching = query.trim().length > 0;
  const results = useMemo(() => searchBookmarks(entries, query), [entries, query]);

  // 浏览/整理模式需要规则与覆盖参与分类；搜索模式保持零额外依赖。
  useEffect(() => {
    if (mode === 'search') return;
    let disposed = false;
    void (async (): Promise<void> => {
      try {
        const state = await repo.load();
        if (!disposed) {
          setOrganizerState(state);
          setOrganizerError(null);
        }
      } catch (cause) {
        if (!disposed) setOrganizerError(cause instanceof Error ? cause.message : '规则加载失败');
      }
    })();
    const handleStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area !== 'local' || !changes[ORGANIZER_STORAGE_KEY]) return;
      void repo.load().then((state) => { if (!disposed) setOrganizerState(state); }).catch(() => {});
    };
    try {
      chrome.storage.onChanged.addListener(handleStorage);
    } catch {
      // 测试桩可能未提供 storage 事件。
    }
    return () => {
      disposed = true;
      try {
        chrome.storage.onChanged.removeListener(handleStorage);
      } catch {
        // 同上
      }
    };
  }, [mode, repo]);

  const classifiedEntries = useMemo<ClassifiedEntry[]>(() => {
    if (!organizerState) return [];
    return entries.map((entry) => {
      const override = organizerState.overrides[entry.id];
      const validOverride = override && override.urlFingerprint === urlFingerprint(entry.url) ? override : undefined;
      const classification = classifyBookmark(
        {
          title: entry.title,
          url: entry.url,
          folderNames: entry.folderPath ? entry.folderPath.split(' / ').filter(Boolean) : [],
        },
        organizerState.rules,
        validOverride,
      );
      return {
        entry,
        purpose: classification.purpose,
        project: classification.project,
        environment: classification.environment,
        verdict: classification.verdict,
      };
    });
  }, [entries, organizerState]);

  const browseVisible = useMemo(() => {
    if (mode !== 'browse') return [];
    const base = searching ? searchBookmarks(entries, query, 500) : entries;
    const allowed = new Set(base.map((entry) => entry.id));
    return classifiedEntries.filter((item) => allowed.has(item.entry.id) &&
      (filters.purpose === 'all' || item.purpose === filters.purpose) &&
      (filters.environment === 'all' || item.environment === filters.environment) &&
      (filters.project === 'all' || item.project === filters.project));
  }, [mode, entries, classifiedEntries, query, searching, filters]);

  const browseGroups = useMemo(() => PURPOSE_ORDER
    .map((purpose) => {
      const groupItems = browseVisible.filter((item) => browseGroupKey(item) === purpose);
      return { purpose, items: groupItems, folderCount: new Set(groupItems.map((item) => item.entry.folderPath)).size };
    })
    .filter((group) => group.items.length > 0), [browseVisible]);

  const projectOptions = useMemo(() => {
    const projects = new Set(classifiedEntries.map((item) => item.project));
    return [...projects].sort();
  }, [classifiedEntries]);

  /** 键盘导航的扁平结果：搜索模式与浏览模式共享同一套上下键/Enter 语义。 */
  const flatResults = mode === 'browse' ? browseVisible.map((item) => item.entry) : results;

  // 按书签 ID 保留选中：条目被删或不再匹配时回落到第一项，Enter 不会打开旧条目。
  const matchedIndex = flatResults.findIndex((entry) => entry.id === activeId);
  const activeIndex = matchedIndex >= 0 ? Math.min(matchedIndex, flatResults.length - 1) : 0;
  const activeEntry = flatResults[activeIndex] as BookmarkEntry | undefined;

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
    if (mode !== 'organize') inputRef.current?.focus();
  }, [focusToken, mode]);

  useEffect(() => {
    document.querySelector('.history-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [activeId, flatResults]);

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
      setActiveId(flatResults.length ? (flatResults[Math.min(activeIndex + 1, flatResults.length - 1)]?.id ?? null) : null);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveId(flatResults[Math.max(activeIndex - 1, 0)]?.id ?? null);
    } else if (event.key === 'Enter') {
      if (activeEntry) void openNewTab(activeEntry);
    }
  };

  /** “保存当前页到推荐文件夹”：先用分类引擎给出建议，用户可在保存前修改。 */
  const recommendSavePage = async (draft: NonNullable<typeof savePage>): Promise<void> => {
    const ticket = ++saveRequestSeq.current;
    setRecommendingPage(true);
    setPageMessage('正在推荐目标文件夹…');
    try {
      const response = await sendBookmarkCommand({ type: 'RECOMMEND_PAGE_BOOKMARK', title: draft.title.trim() || draft.url, url: draft.url });
      if (ticket !== saveRequestSeq.current) return;
      if (!response.ok) throw new Error(response.error);
      if (!response.recommendation) throw new Error('未收到推荐，请重试。');
      const suggestion = response.recommendation;
      setSavePage({ ...draft, targetPath: suggestion.targetPath ?? draft.targetPath });
      setPageMessage(`${suggestion.source === 'AI' ? 'AI 推荐' : '用户规则'}${suggestion.certain ? '' : '（需确认）'}：${suggestion.reason}。请检查目标后保存。`);
    } catch (cause) {
      if (ticket === saveRequestSeq.current) setPageMessage(cause instanceof Error ? cause.message : '推荐失败，可重试或手动选择目标。');
    } finally { if (ticket === saveRequestSeq.current) setRecommendingPage(false); }
  };

  const cancelSavePage = (): void => {
    saveRequestSeq.current += 1;
    setRecommendingPage(false);
    setSavePage(null);
    setPageMessage(null);
  };

  const openSavePagePanel = async (): Promise<void> => {
    const ticket = ++saveRequestSeq.current;
    setRecommendingPage(false);
    setPageMessage(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (ticket !== saveRequestSeq.current) return;
      if (!tab?.url || !/^https?:/.test(tab.url)) {
        setSavePage({ title: tab?.title ?? '', url: tab?.url ?? '', targetPath: '' });
        setPageMessage('当前页面不是 http(s) 网页，无法收藏。');
        return;
      }
      const classification = classifyBookmark(
        { title: tab.title ?? '', url: tab.url, folderNames: [] },
        organizerState?.rules ?? [],
        undefined,
      );
      const draft = { title: tab.title ?? tab.url, url: tab.url, targetPath: suggestedTargetPath(classification) ?? '' };
      setSavePage(draft);
      if (organizerState?.settings.aiAutoPlaceEnabled) await recommendSavePage(draft);
    } catch (cause) {
      if (ticket === saveRequestSeq.current) setError(cause instanceof Error ? cause.message : '无法读取当前标签页');
    }
  };

  const submitSavePage = async (): Promise<void> => {
    if (!savePage || savingPage || recommendingPage) return;
    setSavingPage(true);
    try {
      const response = await sendBookmarkCommand({
        type: 'SAVE_PAGE_BOOKMARK',
        title: savePage.title.trim() || savePage.url,
        url: savePage.url,
        targetPath: savePage.targetPath,
      });
      if (!response.ok) throw new Error(response.error);
      setSavePage(null);
      setPageMessage('已保存当前页');
      void refresh();
    } catch (cause) {
      setPageMessage(cause instanceof Error ? cause.message : '保存失败');
    } finally { setSavingPage(false); }
  };

  const listEmptyText = loading
    ? '正在加载书签…'
    : !searching
      ? (mode === 'browse' ? '没有可浏览的书签' : '输入关键字搜索书签')
      : '没有匹配的书签，试试名称、网址或文件夹中的其他关键词。';

  return (
    <>
      <header className="page-header">
        <button className="icon-button" onClick={onBack} aria-label="返回表单历史">←</button>
        <div><span className="eyebrow">书签搜索</span><h1>浏览器书签</h1></div>
        <button className="icon-button bookmark-close" onClick={() => void closePanel()} aria-label="关闭书签搜索侧栏" title="关闭侧栏（Esc）">×</button>
      </header>

      <div className="bookmark-modes" role="group" aria-label="书签页模式">
        {([['search', '搜索'], ['browse', '浏览'], ['organize', '整理']] as Array<[BookmarkPageMode, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`mode-tab${mode === value ? ' active' : ''}`}
            aria-pressed={mode === value}
            onClick={() => updateUi({ mode: value })}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'organize' ? (
        <BookmarkOrganizePage active />
      ) : (
        <section className="history-section">
          <div className="section-heading"><h2>书签</h2><span>{mode === 'browse' ? browseVisible.length : (searching ? results.length : entries.length)}</span></div>
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input
              ref={inputRef}
              role="combobox"
              aria-label="搜索浏览器书签"
              aria-autocomplete="list"
              aria-expanded={searching && !loading && flatResults.length > 0}
              aria-controls={flatResults.length > 0 ? 'bookmark-listbox' : undefined}
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
          <p className="visually-hidden" role="status">
            {mode === 'browse'
              ? `浏览 ${browseVisible.length} 个书签`
              : (searching ? `找到 ${results.length} 个书签` : '')}
          </p>
          {mode === 'browse' && organizerError && <div className="inline-error" role="alert">{organizerError}</div>}
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

          {mode === 'browse' && organizerState && (
            <div className="browse-panel">
              <div className="browse-summary" role="status">
                待确认 {classifiedEntries.filter((item) => browseGroupKey(item) === 'unknown').length} 条
                {classifiedEntries.some((item) => item.verdict === 'conflict') ? ` · 冲突 ${classifiedEntries.filter((item) => item.verdict === 'conflict').length} 条` : ''}
              </div>
              <div className="organize-filters" role="group" aria-label="按用途筛选">
                <button type="button" className={`chip${filters.purpose === 'all' ? ' active' : ''}`} aria-pressed={filters.purpose === 'all'} onClick={() => setFilters({ purpose: 'all' })}>全部用途</button>
                {PURPOSE_ORDER.filter((purpose) => purpose !== 'unknown').map((purpose) => (
                  <button
                    key={purpose}
                    type="button"
                    className={`chip${filters.purpose === purpose ? ' active' : ''}`}
                    aria-pressed={filters.purpose === purpose}
                    onClick={() => setFilters({ purpose: filters.purpose === purpose ? 'all' : purpose })}
                  >
                    {purposeLabel(purpose)}
                  </button>
                ))}
              </div>
              <div className="organize-filters" role="group" aria-label="按环境筛选">
                <button type="button" className={`chip${filters.environment === 'all' ? ' active' : ''}`} aria-pressed={filters.environment === 'all'} onClick={() => setFilters({ environment: 'all' })}>全部环境</button>
                {(['prod', 'pre', 'demo', 'test', 'unknown'] as BookmarkEnvironment[]).map((environment) => (
                  <button
                    key={environment}
                    type="button"
                    className={`chip${filters.environment === environment ? ' active' : ''}`}
                    aria-pressed={filters.environment === environment}
                    onClick={() => setFilters({ environment: filters.environment === environment ? 'all' : environment })}
                  >
                    {environment === 'unknown' ? '环境未知' : environment}
                  </button>
                ))}
              </div>
              {projectOptions.length > 1 && (
                <label className="field-label browse-project-filter">
                  项目
                  <select aria-label="按项目筛选" value={filters.project} onChange={(event) => setFilters({ project: event.target.value })}>
                    <option value="all">全部项目</option>
                    {projectOptions.map((project) => (
                      <option key={project} value={project}>{project === 'general' ? '通用' : project}</option>
                    ))}
                  </select>
                </label>
              )}
              <button type="button" className="small-button" disabled={savingPage || recommendingPage} onClick={() => void openSavePagePanel()}>
                保存当前页到推荐文件夹
              </button>
              {savePage && (
                <div className="save-page-panel">
                  <label className="field-label">
                    标题
                    <input aria-label="书签标题" disabled={savingPage || recommendingPage} value={savePage.title} onChange={(event) => setSavePage({ ...savePage, title: event.target.value })} />
                  </label>
                  <label className="field-label">
                    目标文件夹
                    <input
                      aria-label="目标文件夹"
                      disabled={savingPage || recommendingPage}
                      value={savePage.targetPath}
                      placeholder="如 业务系统/某项目"
                      onChange={(event) => setSavePage({ ...savePage, targetPath: event.target.value })}
                    />
                  </label>
                  <div className="button-row">
                    <button type="button" className="secondary-button" disabled={savingPage || recommendingPage || !/^https?:/.test(savePage.url)} onClick={() => void recommendSavePage(savePage)}>
                      {recommendingPage ? 'AI 正在推荐…' : 'AI 推荐文件夹'}
                    </button>
                    <button type="button" className="primary-button" disabled={savingPage || recommendingPage || !savePage.targetPath.trim() || !/^https?:/.test(savePage.url)} onClick={() => void submitSavePage()}>{savingPage ? '正在保存…' : '保存'}</button>
                    <button type="button" className="text-button" disabled={savingPage} onClick={cancelSavePage}>取消</button>
                  </div>
                </div>
              )}
              {pageMessage && <p className="copy-hint" role="status">{pageMessage}</p>}
            </div>
          )}

          <div
            className="history-list"
            id="bookmark-listbox"
            role={flatResults.length > 0 ? 'listbox' : undefined}
            aria-label={flatResults.length > 0 ? '书签结果' : undefined}
          >
            {mode === 'browse' ? (
              browseGroups.length === 0 ? (
                <div className="empty-list">{listEmptyText}</div>
              ) : (
                browseGroups.map((group) => (
                  <div key={group.purpose} className="browse-group" role="group" aria-label={purposeLabel(group.purpose)}>
                    <h3 className="browse-group-title">
                      {purposeLabel(group.purpose)} · {group.items.length} 条 · {group.folderCount} 个文件夹
                    </h3>
                    {group.items.map((item) => (
                      <BookmarkItem
                        key={item.entry.id}
                        entry={item.entry}
                        active={item.entry.id === activeEntry?.id}
                        onOpen={() => void openNewTab(item.entry)}
                      />
                    ))}
                  </div>
                ))
              )
            ) : loading ? (
              <div className="empty-list">{listEmptyText}</div>
            ) : !searching ? (
              <div className="empty-list">{listEmptyText}</div>
            ) : results.length === 0 ? (
              <div className="empty-list">{listEmptyText}</div>
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
      )}
    </>
  );
}
