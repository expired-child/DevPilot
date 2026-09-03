import { useCallback, useEffect, useMemo, useState } from 'react';

import { ChromeClipboardRepository, STORAGE_KEY } from '../modules/form-clipboard/clipboard-repository';
import { ClipboardService } from '../modules/form-clipboard/clipboard-service';
import type {
  FieldAssignment,
  FillIssue,
  FillReport,
  FormClipboardItem,
  FormClipboardState,
  FormField,
} from '../modules/form-clipboard/clipboard-types';
import { getActiveTab, scanActiveTab, sendToTab } from '../shared/messaging/tab-messaging';
import { ClipboardDetailPage } from './pages/ClipboardDetailPage';
import { ClipboardPage } from './pages/ClipboardPage';
import { PastePreviewPage } from './pages/PastePreviewPage';

type View = { page: 'list' } | { page: 'detail'; itemId: string } | { page: 'preview'; itemId: string; targetFields: FormField[]; targetTitle?: string };

const repository = new ChromeClipboardRepository();
const service = new ClipboardService(repository);

export function App() {
  const [state, setState] = useState<FormClipboardState | null>(null);
  const [view, setView] = useState<View>({ page: 'list' });
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const reload = useCallback(async (): Promise<FormClipboardState> => {
    const next = await service.getState();
    setState(next);
    return next;
  }, []);

  const showError = (error: unknown): void => {
    setNotice({
      tone: 'error',
      text:
        error instanceof Error && /Receiving end does not exist|Could not establish connection/.test(error.message)
          ? '当前页面不允许扩展访问，请切换到普通网页后重试。'
          : error instanceof Error
            ? error.message
            : '操作失败',
    });
  };

  const startPaste = useCallback(async (item: FormClipboardItem): Promise<void> => {
    try {
      const target = await scanActiveTab();
      setView({
        page: 'preview',
        itemId: item.id,
        targetFields: target.fields,
        targetTitle: target.source.title,
      });
      setNotice(null);
    } catch (error) {
      showError(error);
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

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const item = useMemo(() => {
    if (!state || view.page === 'list') return null;
    return state.history.find((entry) => entry.id === view.itemId) ?? null;
  }, [state, view]);

  if (!state) {
    return <div className="loading">正在打开 DevPilot…</div>;
  }

  const copyCurrent = async (): Promise<void> => {
    try {
      const scan = await scanActiveTab();
      if (scan.fields.length === 0) throw new Error('当前页面没有可复制的表单字段');
      const captured = await service.capture(scan);
      await reload();
      setNotice({ tone: 'success', text: `已复制 ${captured.name} · ${captured.fields.length} 个字段` });
    } catch (error) {
      showError(error);
    }
  };

  const confirmFill = async (assignments: FieldAssignment[], skipped: FillIssue[]): Promise<FillReport | null> => {
    try {
      const tab = await getActiveTab();
      const response = await sendToTab(tab.id!, { type: 'APPLY_FIELDS', assignments });
      if (!response.ok || !('report' in response)) throw new Error(response.ok ? '未获取到填充结果' : response.error);
      const report: FillReport = {
        ...response.report,
        skipped: response.report.skipped + skipped.length,
        issues: [...response.report.issues, ...skipped],
      };
      setNotice({ tone: report.failed ? 'error' : 'success', text: `填充完成：成功 ${report.success}，跳过 ${report.skipped}，失败 ${report.failed}` });
      return report;
    } catch (error) {
      showError(error);
      return null;
    }
  };

  return (
    <main className="app-shell">
      {notice && <div className={`notice ${notice.tone}`}>{notice.text}</div>}
      {view.page === 'list' && (
        <ClipboardPage
          state={state}
          onCopy={() => void copyCurrent()}
          onPaste={(entry) => void startPaste(entry)}
          onDetail={(entry) => setView({ page: 'detail', itemId: entry.id })}
          onClear={async () => {
            await service.clear();
            await reload();
          }}
        />
      )}
      {view.page === 'detail' && item && (
        <ClipboardDetailPage
          item={item}
          onBack={() => setView({ page: 'list' })}
          onPaste={() => void startPaste(item)}
          onRename={async (name) => {
            await service.rename(item.id, name);
            await reload();
          }}
          onDelete={async () => {
            await service.remove(item.id);
            await reload();
            setView({ page: 'list' });
          }}
          onPin={async () => {
            await service.togglePin(item.id);
            await reload();
          }}
          onUnique={async (fieldKey, unique) => {
            await service.setUniqueField(item.id, fieldKey, unique);
            await reload();
          }}
          onExclude={async (fieldKey, excluded) => {
            await service.setFieldExcluded(item.id, fieldKey, excluded);
            await reload();
          }}
          onSaveFields={async (fields: FormField[]) => {
            await service.saveFields(item.id, fields);
            await reload();
            setNotice({ tone: 'success', text: '字段模板已保存' });
          }}
        />
      )}
      {view.page === 'preview' && item && (
        <PastePreviewPage
          item={item}
          targetFields={view.targetFields}
          targetTitle={view.targetTitle}
          onBack={() => setView({ page: 'list' })}
          onConfirm={confirmFill}
        />
      )}
    </main>
  );
}
