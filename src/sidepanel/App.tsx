import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ChromeClipboardRepository, STORAGE_KEY } from '../modules/form-clipboard/clipboard-repository';
import type {
  FieldAssignment,
  FillIssue,
  FillReport,
  FormClipboardDetails,
  FormClipboardItem,
  FormClipboardState,
  FormField,
  FormTargetSnapshot,
  ReplacementRule,
} from '../modules/form-clipboard/clipboard-types';
import { createFingerprint } from '../modules/form-clipboard/fingerprint';
import {
  getActiveTab,
  listFormCandidates,
  scanScope,
  scanTab,
  sendToTab,
  uniqueCandidate,
  type CandidateOption,
  type ScannedTab,
} from '../shared/messaging/tab-messaging';
import { sendClipboardCommand, type ClipboardCommand, type ClipboardCommandResult } from '../shared/messaging/clipboard-commands';
import { BOOKMARK_SEARCH_TRIGGER, type BookmarkSearchTrigger } from '../shared/constants';
import { currentWindowId, loadGlobalDraft, sameRules, saveGlobalDraft } from './global-draft-store';
import { BookmarkSearchPage } from './pages/BookmarkSearchPage';
import { ClipboardDetailPage } from './pages/ClipboardDetailPage';
import { ClipboardPage } from './pages/ClipboardPage';
import { FormCandidatesPage } from './pages/FormCandidatesPage';
import { PastePreviewPage } from './pages/PastePreviewPage';

type View =
  | { page: 'list' }
  | { page: 'bookmarks' }
  | { page: 'detail'; itemId: string }
  | { page: 'candidates'; intent: 'copy'; tabId: number }
  | { page: 'candidates'; intent: 'preview'; itemId: string; tabId: number }
  | {
    page: 'preview'; itemId: string; targetTabId: number; targetFrameId: number;
    targetDocumentId?: string; targetSnapshot: FormTargetSnapshot;
    targetFields: FormField[]; targetTitle?: string;
  };

const repository = new ChromeClipboardRepository();

const errorText = (error: unknown): string =>
  error instanceof Error && /Receiving end does not exist|Could not establish connection/.test(error.message)
    ? '当前页面不允许扩展访问，请切换到普通网页后重试。'
    : error instanceof Error ? error.message : '操作失败';

/** 写操作统一经后台协调器执行；失败抛错保持可重试状态，成功才返回响应。 */
const submitCommand = async (command: ClipboardCommand): Promise<Extract<ClipboardCommandResult, { ok: true }>> => {
  const response = await sendClipboardCommand(command);
  if (!response.ok) throw new Error(response.error);
  return response;
};

const buildPreviewView = (itemId: string, tabId: number, target: ScannedTab): Extract<View, { page: 'preview' }> => {
  const { scan } = target;
  return {
    page: 'preview', itemId, targetTabId: tabId,
    targetFrameId: target.frameId, targetDocumentId: target.documentId,
    targetSnapshot: {
      url: scan.source.url,
      fingerprint: createFingerprint(scan.source.host, scan.fields),
      scopeId: scan.scopeId,
    },
    targetFields: scan.fields,
    targetTitle: scan.suggestedName || scan.source.title,
  };
};

export function App() {
  const [state, setState] = useState<FormClipboardState | null>(null);
  const [view, setView] = useState<View>({ page: 'list' });
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [replacementPending, setReplacementPending] = useState(false);
  const [replacementDraft, setReplacementDraft] = useState<ReplacementRule[] | null>(null);
  const [replacementDraftConflict, setReplacementDraftConflict] = useState(false);
  const [candidates, setCandidates] = useState<CandidateOption[]>([]);
  const [bookmarkFocusToken, setBookmarkFocusToken] = useState(0);
  const lastBookmarkRequest = useRef<string | null>(null);
  const draftBaseRef = useRef<ReplacementRule[] | null>(null);
  const replacementDraftRef = useRef<ReplacementRule[] | null>(null);
  const draftTouchedRef = useRef(false);
  const draftWriteVersionRef = useRef(0);

  const openBookmarks = useCallback((): void => {
    setView({ page: 'bookmarks' });
    setBookmarkFocusToken((token) => token + 1);
  }, []);

  // 恢复本窗口上次会话遗留的未应用草稿；正式规则若已被其他窗口更新则提示核对。
  useEffect(() => {
    let disposed = false;
    void (async (): Promise<void> => {
      const windowId = await currentWindowId();
      if (windowId === null || disposed || draftTouchedRef.current) return;
      const record = await loadGlobalDraft(windowId).catch(() => null);
      if (!record || disposed || draftTouchedRef.current) return;
      const state = await repository.get();
      if (disposed) return;
      if (sameRules(record.draft, state.settings.replacementRules ?? [])) {
        await saveGlobalDraft(windowId, null).catch(() => {});
        return;
      }
      draftBaseRef.current = record.baseRules;
      replacementDraftRef.current = record.draft;
      setReplacementDraft(record.draft);
      setReplacementDraftConflict(!sameRules(record.baseRules, state.settings.replacementRules ?? []));
    })();
    return () => { disposed = true; };
  }, []);

  const changeReplacementDraft = useCallback((rules: ReplacementRule[] | null): void => {
    draftTouchedRef.current = true;
    const version = ++draftWriteVersionRef.current;
    replacementDraftRef.current = rules;
    setReplacementDraft(rules);
    if (!rules) {
      setReplacementDraftConflict(false);
      draftBaseRef.current = null;
    } else if (draftBaseRef.current === null) {
      draftBaseRef.current = state?.settings.replacementRules ?? [];
    }
    void (async (): Promise<void> => {
      try {
        const windowId = await currentWindowId();
        if (windowId === null || version !== draftWriteVersionRef.current) return;
        await saveGlobalDraft(windowId, rules
          ? { baseRules: draftBaseRef.current ?? [], draft: rules, savedAt: Date.now() }
          : null);
      } catch (error) {
        if (version === draftWriteVersionRef.current) {
          setNotice({ tone: 'error', text: `草稿暂存失败：${errorText(error)}` });
        }
      }
    })();
  }, [state]);

  const rebaseReplacementDraft = (): void => {
    if (!replacementDraftRef.current || !state) return;
    draftBaseRef.current = state.settings.replacementRules ?? [];
    setReplacementDraftConflict(false);
    changeReplacementDraft(replacementDraftRef.current);
  };

  const reload = useCallback(async (): Promise<FormClipboardState> => {
    const next = await repository.get();
    setState(next);
    if (replacementDraftRef.current && draftBaseRef.current) {
      setReplacementDraftConflict(!sameRules(draftBaseRef.current, next.settings.replacementRules ?? []));
    }
    return next;
  }, []);

  const showError = (error: unknown): void => {
    setNotice({ tone: 'error', text: errorText(error) });
  };

  const startPaste = useCallback(async (item: FormClipboardItem): Promise<void> => {
    try {
      const tab = await getActiveTab();
      const options = (await listFormCandidates(tab.id!)).filter((option) => option.fieldCount > 0);
      if (options.length === 0) throw new Error('当前页面没有可填充的表单字段');
      const chosen = uniqueCandidate(options);
      if (!chosen) {
        setCandidates(options);
        setView({ page: 'candidates', intent: 'preview', itemId: item.id, tabId: tab.id! });
        return;
      }
      setView(buildPreviewView(item.id, tab.id!, await scanScope(tab.id!, chosen)));
      setNotice(null);
    } catch (error) {
      throw new Error(errorText(error), { cause: error });
    }
  }, []);

  useEffect(() => {
    void repository.get().then(setState);

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
    if (!state || view.page === 'list' || view.page === 'bookmarks' || view.page === 'candidates') return null;
    return state.history.find((entry) => entry.id === view.itemId) ?? null;
  }, [state, view]);

  if (!state && view.page !== 'bookmarks' && view.page !== 'candidates') {
    return <div className="loading">正在打开 DevPilot…</div>;
  }

  const listCandidates = async (): Promise<CandidateOption[]> => {
    const tab = await getActiveTab();
    const options = (await listFormCandidates(tab.id!)).filter((option) => option.fieldCount > 0);
    if (options.length === 0) throw new Error('当前页面没有可用的表单');
    setCandidates(options);
    setView((current) => current.page === 'candidates' ? { ...current, tabId: tab.id! } : current);
    return options;
  };

  const captureCandidate = async (tabId: number, option: CandidateOption): Promise<void> => {
    const target = await scanScope(tabId, option);
    const response = await submitCommand({ type: 'CAPTURE_FORM', scan: target.scan });
    await reload();
    setView({ page: 'list' });
    const captured = response.item;
    setNotice({ tone: 'success', text: captured
      ? `已复制 ${captured.name} · ${captured.fields.length} 个字段 · ${target.scan.source.title || target.scan.source.host}`
      : '已复制当前表单' });
  };

  const copyCurrent = async (): Promise<void> => {
    try {
      const tab = await getActiveTab();
      const options = (await listFormCandidates(tab.id!)).filter((option) => option.fieldCount > 0);
      if (options.length === 0) throw new Error('当前页面没有可复制的表单字段');
      const chosen = uniqueCandidate(options);
      if (!chosen) {
        // 多个候选：交给用户选择，不猜测目标表单。
        setCandidates(options);
        setView({ page: 'candidates', intent: 'copy', tabId: tab.id! });
        return;
      }
      await captureCandidate(tab.id!, chosen);
    } catch (error) {
      showError(error);
    }
  };

  const selectCandidate = async (option: CandidateOption): Promise<void> => {
    if (view.page !== 'candidates') return;
    const intent = view.intent;
    try {
      const tab = await getActiveTab();
      if (tab.id !== view.tabId) throw new Error('目标标签页已切换，请重新扫描并选择表单。');
      if (intent === 'copy') {
        await captureCandidate(tab.id!, option);
      } else {
        setView(buildPreviewView(view.itemId, tab.id!, await scanScope(tab.id!, option)));
      }
    } catch (error) {
      // 目标在选择后变化：说明原因、保留来源记录并刷新候选列表。
      showError(error);
      await refreshCandidates();
    }
  };

  const refreshCandidates = async (): Promise<void> => {
    try {
      await listCandidates();
    } catch (error) {
      showError(error);
    }
  };

  const toggleReplacement = async (enabled: boolean): Promise<void> => {
    setReplacementPending(true);
    try {
      await submitCommand({ type: 'SET_REPLACEMENT_ENABLED', enabled });
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
      }, view.targetDocumentId ? { documentId: view.targetDocumentId } : { frameId: view.targetFrameId });
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
            try {
              await submitCommand({
                type: 'SAVE_REPLACEMENT_RULES', rules,
                expectedRules: draftBaseRef.current ?? state.settings.replacementRules ?? [],
              });
            } catch (error) {
              await reload();
              throw error;
            }
            ++draftWriteVersionRef.current;
            draftBaseRef.current = null;
            replacementDraftRef.current = null;
            setReplacementDraft(null);
            setReplacementDraftConflict(false);
            let cleanupError: unknown;
            try {
              const windowId = await currentWindowId();
              if (windowId !== null) await saveGlobalDraft(windowId, null);
            } catch (error) {
              cleanupError = error;
            }
            await reload();
            setNotice(cleanupError
              ? { tone: 'error', text: `全局规则已保存，但草稿清理失败：${errorText(cleanupError)}` }
              : { tone: 'success', text: '全局替换规则已保存' });
          }}
          onCopy={() => void copyCurrent()}
          onPaste={(entry) => void startPaste(entry).catch(showError)}
          onDetail={(entry) => setView({ page: 'detail', itemId: entry.id })}
          onBookmarks={openBookmarks}
          onClear={async () => {
            await submitCommand({ type: 'CLEAR_HISTORY' });
            await reload();
          }}
          replacementDraft={replacementDraft}
          replacementDraftConflict={replacementDraftConflict}
          onReplacementDraftChange={changeReplacementDraft}
          onReplacementDraftRebase={rebaseReplacementDraft}
        />
      )}
      {view.page === 'bookmarks' && (
        <BookmarkSearchPage focusToken={bookmarkFocusToken} onBack={() => setView({ page: 'list' })} />
      )}
      {view.page === 'candidates' && (
        <FormCandidatesPage
          candidates={candidates}
          title={view.intent === 'copy' ? '选择要复制的表单' : '选择要填充的目标表单'}
          onSelect={(option) => void selectCandidate(option)}
          onRefresh={() => void refreshCandidates()}
          onBack={() => setView({ page: 'list' })}
        />
      )}
      {view.page === 'detail' && item && (
        <ClipboardDetailPage
          key={item.id}
          item={item}
          onBack={() => setView({ page: 'list' })}
          onPaste={() => startPaste(item)}
          onSave={async (details: FormClipboardDetails) => {
            await submitCommand({ type: 'SAVE_DETAILS', id: item.id, details });
            await reload();
            setNotice({ tone: 'success', text: '更改已保存' });
          }}
          onDelete={async () => {
            await submitCommand({ type: 'REMOVE_ITEM', id: item.id });
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
            if (view.page !== 'preview') return;
            try {
              // 重新扫描同一个作用域；作用域消失则回到候选选择并说明原因。
              const target = view.targetSnapshot.scopeId
                ? await scanScope(view.targetTabId, {
                  scopeId: view.targetSnapshot.scopeId,
                  frameId: view.targetFrameId,
                  documentId: view.targetDocumentId,
                })
                : await scanTab(view.targetTabId);
              setView(buildPreviewView(view.itemId, view.targetTabId, target));
            } catch (error) {
              showError(error);
              setView({ page: 'candidates', intent: 'preview', itemId: view.itemId, tabId: view.targetTabId });
              await refreshCandidates();
            }
          }}
          onConfirm={confirmFill}
        />
      )}
    </main>
  );
}
