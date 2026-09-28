import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ChromeClipboardRepository, STORAGE_KEY } from '../modules/form-clipboard/clipboard-repository';
import { ClipboardService } from '../modules/form-clipboard/clipboard-service';
import type {
  FieldAssignment,
  FillIssue,
  FillReport,
  FormClipboardDetails,
  FormClipboardItem,
  FormClipboardState,
  FormField,
  FormTargetSnapshot,
} from '../modules/form-clipboard/clipboard-types';
import { createFingerprint } from '../modules/form-clipboard/fingerprint';
import { getActiveTab, scanActiveTab, scanTab, sendToTab } from '../shared/messaging/tab-messaging';
import { BOOKMARK_SEARCH_TRIGGER, type BookmarkSearchTrigger } from '../shared/constants';
import { BookmarkSearchPage } from './pages/BookmarkSearchPage';
import { ClipboardDetailPage } from './pages/ClipboardDetailPage';
import { ClipboardPage } from './pages/ClipboardPage';
import { PastePreviewPage } from './pages/PastePreviewPage';

type View = { page: 'list' } | { page: 'bookmarks' } | { page: 'detail'; itemId: string } | {
  page: 'preview'; itemId: string; targetTabId: number; targetSnapshot: FormTargetSnapshot;
  targetFields: FormField[]; targetTitle?: string;
};

const repository = new ChromeClipboardRepository();
const service = new ClipboardService(repository);

const errorText = (error: unknown): string =>
  error instanceof Error && /Receiving end does not exist|Could not establish connection/.test(error.message)
    ? '当前页面不允许扩展访问，请切换到普通网页后重试。'
    : error instanceof Error ? error.message : '操作失败';

const scanPreview = async (itemId: string): Promise<Extract<View, { page: 'preview' }>> => {
  const tab = await getActiveTab();
  const target = await scanTab(tab.id!);
  if (target.fields.length === 0) throw new Error('当前页面没有可填充的表单字段');
  return {
    page: 'preview', itemId, targetTabId: tab.id!,
    targetSnapshot: {
      url: target.source.url,
      fingerprint: createFingerprint(target.source.host, target.fields),
    },
    targetFields: target.fields,
    targetTitle: target.source.title,
  };
};

export function App() {
  const [state, setState] = useState<FormClipboardState | null>(null);
  const [view, setView] = useState<View>({ page: 'list' });
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [replacementPending, setReplacementPending] = useState(false);
  const [bookmarkFocusToken, setBookmarkFocusToken] = useState(0);
  const lastBookmarkRequest = useRef<string | null>(null);

  const openBookmarks = useCallback((): void => {
    setView({ page: 'bookmarks' });
    setBookmarkFocusToken((token) => token + 1);
  }, []);

  const reload = useCallback(async (): Promise<FormClipboardState> => {
    const next = await service.getState();
    setState(next);
    return next;
  }, []);

  const showError = (error: unknown): void => {
    setNotice({ tone: 'error', text: errorText(error) });
  };

  const startPaste = useCallback(async (item: FormClipboardItem): Promise<void> => {
    try {
      setView(await scanPreview(item.id));
      setNotice(null);
    } catch (error) {
      throw new Error(errorText(error), { cause: error });
    }
  }, []);

  useEffect(() => {
    void service.getState().then(setState);

    const handleStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area === 'local' && changes[STORAGE_KEY]) void reload();
    };
    chrome.storage.onChanged.addListener(handleStorage);
    return () => chrome.storage.onChanged.removeListener(handleStorage);
  }, [reload]);

  // 冷启动读会话标记，已打开的侧栏监听变化；只处理本窗口的快捷键。
  useEffect(() => {
    let disposed = false;
    const consumeTrigger = async (trigger: BookmarkSearchTrigger | undefined): Promise<void> => {
      if (!trigger || typeof trigger.windowId !== 'number' || typeof trigger.requestId !== 'string') return;
      const currentWindow = await chrome.windows.getCurrent();
      if (disposed || currentWindow.id !== trigger.windowId || lastBookmarkRequest.current === trigger.requestId) return;
      lastBookmarkRequest.current = trigger.requestId;
      openBookmarks();
      const stored = (await chrome.storage.session.get(BOOKMARK_SEARCH_TRIGGER))[BOOKMARK_SEARCH_TRIGGER] as BookmarkSearchTrigger | undefined;
      if (stored?.requestId === trigger.requestId) await chrome.storage.session.remove(BOOKMARK_SEARCH_TRIGGER);
    };
    void chrome.storage.session.get(BOOKMARK_SEARCH_TRIGGER).then((stored) => {
      void consumeTrigger(stored[BOOKMARK_SEARCH_TRIGGER] as BookmarkSearchTrigger | undefined);
    });
    const handleSession = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area === 'session') void consumeTrigger(changes[BOOKMARK_SEARCH_TRIGGER]?.newValue as BookmarkSearchTrigger | undefined);
    };
    chrome.storage.onChanged.addListener(handleSession);
    return () => {
      disposed = true;
      chrome.storage.onChanged.removeListener(handleSession);
    };
  }, [openBookmarks]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const item = useMemo(() => {
    if (!state || view.page === 'list' || view.page === 'bookmarks') return null;
    return state.history.find((entry) => entry.id === view.itemId) ?? null;
  }, [state, view]);

  if (!state && view.page !== 'bookmarks') {
    return <div className="loading">正在打开 DevPilot…</div>;
  }

  const copyCurrent = async (): Promise<void> => {
    try {
      const scan = await scanActiveTab();
      if (scan.fields.length === 0) throw new Error('当前页面没有可复制的表单字段');
      const captured = await service.capture(scan);
      await reload();
      setNotice({ tone: 'success', text: `已复制 ${captured.name} · ${captured.fields.length} 个字段 · ${scan.source.title || scan.source.host}` });
    } catch (error) {
      showError(error);
    }
  };

  const toggleReplacement = async (enabled: boolean): Promise<void> => {
    setReplacementPending(true);
    try {
      await service.setReplacementEnabled(enabled);
      await reload();
    } catch (error) {
      showError(error);
    } finally {
      setReplacementPending(false);
    }
  };

  const confirmFill = async (assignments: FieldAssignment[], skipped: FillIssue[]): Promise<FillReport> => {
    try {
      if (view.page !== 'preview') throw new Error('预览已失效，请重新打开粘贴预览。');
      const tab = await getActiveTab();
      if (tab.id !== view.targetTabId) throw new Error('目标标签页已切换，请重新扫描当前页。');
      const response = await sendToTab(view.targetTabId, {
        type: 'APPLY_FIELDS', assignments, expectedTarget: view.targetSnapshot,
      });
      if (!response.ok || !('report' in response)) throw new Error(response.ok ? '未获取到填充结果' : response.error);
      const report: FillReport = {
        ...response.report,
        skipped: response.report.skipped + skipped.length,
        issues: [...response.report.issues, ...skipped],
      };
      setNotice({ tone: report.failed ? 'error' : 'success', text: `填充完成：成功 ${report.success}，跳过 ${report.skipped}，失败 ${report.failed}` });
      return report;
    } catch (error) {
      throw new Error(errorText(error), { cause: error });
    }
  };

  return (
    <main className="app-shell">
      {notice && <div className={`notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      {view.page === 'list' && state && (
        <ClipboardPage
          state={state}
          replacementPending={replacementPending}
          onReplacementToggle={toggleReplacement}
          onSaveReplacementRules={async (rules) => {
            await service.saveReplacementRules(rules);
            await reload();
            setNotice({ tone: 'success', text: '全局替换规则已保存' });
          }}
          onCopy={() => void copyCurrent()}
          onPaste={(entry) => void startPaste(entry).catch(showError)}
          onDetail={(entry) => setView({ page: 'detail', itemId: entry.id })}
          onBookmarks={openBookmarks}
          onClear={async () => {
            await service.clear();
            await reload();
          }}
        />
      )}
      {view.page === 'bookmarks' && (
        <BookmarkSearchPage focusToken={bookmarkFocusToken} onBack={() => setView({ page: 'list' })} />
      )}
      {view.page === 'detail' && item && (
        <ClipboardDetailPage
          key={item.id}
          item={item}
          onBack={() => setView({ page: 'list' })}
          onPaste={() => startPaste(item)}
          onSave={async (details: FormClipboardDetails) => {
            await service.saveDetails(item.id, details);
            await reload();
            setNotice({ tone: 'success', text: '更改已保存' });
          }}
          onDelete={async () => {
            await service.remove(item.id);
            await reload();
            setView({ page: 'list' });
          }}
        />
      )}
      {view.page === 'preview' && item && state && (
        <PastePreviewPage
          item={item}
          settings={state.settings}
          replacementPending={replacementPending}
          onReplacementToggle={toggleReplacement}
          targetFields={view.targetFields}
          targetTitle={view.targetTitle}
          onBack={() => setView({ page: 'list' })}
          onRefresh={async () => {
            setView(await scanPreview(view.itemId));
          }}
          onConfirm={confirmFill}
        />
      )}
    </main>
  );
}
