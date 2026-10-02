import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildOrganizePreview,
  groupPlanItemsByTarget,
  emptyFolderCandidates,
  type BuildPreviewOptions,
  type OrganizePlanItem,
  type OrganizePreview,
} from '../../modules/bookmark-organizer/bookmark-plan';
import {
  ChromeOrganizerRepository,
  ORGANIZER_STORAGE_KEY,
  type OrganizeBatch,
  type OrganizerState,
} from '../../modules/bookmark-organizer/bookmark-organizer-repository';
import { listFoldersInSubtree, createBookmarkSnapshot } from '../../modules/bookmark-organizer/bookmark-tree';
import { hostMatchesPattern, pathMatchesPrefix, PURPOSE_LABELS } from '../../modules/bookmark-organizer/bookmark-rules';
import type { BookmarkOverride, UserRule } from '../../modules/bookmark-organizer/bookmark-rules';
import type { BookmarkEnvironment, BookmarkPurpose } from '../../modules/bookmark-organizer/bookmark-classifier';
import { DEEPSEEK_MODEL, BOOKMARK_AI_KEY } from '../../modules/bookmark-organizer/bookmark-ai';
import {
  sendBookmarkCommand,
  type PlannedMove,
} from '../../shared/messaging/bookmark-commands';

type Phase = 'scanning' | 'preview' | 'applying' | 'result';

type RowFilter = 'all' | 'move' | 'review' | 'conflict';

interface FolderOption {
  id: string;
  label: string;
}

interface Props {
  active: boolean;
}

const PURPOSE_OPTIONS = Object.entries(PURPOSE_LABELS) as Array<[Exclude<BookmarkPurpose, 'unknown'>, string]>;
const ENVIRONMENT_OPTIONS: BookmarkEnvironment[] = ['prod', 'pre', 'demo', 'test', 'unknown'];
const VERDICT_LABELS: Record<string, string> = { certain: '确定', review: '待确认', conflict: '冲突' };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : '操作失败');

/** 单条书签行：勾选、理由、可展开的完整信息与目标编辑。 */
function PlanRow({
  item, selectable, expanded, onToggle, onExpand, onTargetChange, onEdit,
}: {
  item: OrganizePlanItem;
  selectable: boolean;
  expanded: boolean;
  onToggle(selected: boolean): void;
  onExpand(): void;
  onTargetChange(path: string): void;
  onEdit(): void;
}) {
  const badge = VERDICT_LABELS[item.classification.verdict];
  return (
    <div className={`organize-row${item.selected ? ' selected' : ''}`} data-bookmark-id={item.bookmarkId}>
      <div className="organize-row-main">
        {selectable ? (
          <input
            type="checkbox"
            aria-label={`选择「${item.title}」`}
            checked={item.selected}
            onChange={(event) => onToggle(event.target.checked)}
          />
        ) : (
          <span className="organize-row-dash" aria-hidden="true">—</span>
        )}
        <button type="button" className="organize-row-title text-button" onClick={onExpand} aria-expanded={expanded}>
          <strong>{item.title}</strong>
          <span className="meta">{item.host}</span>
        </button>
        <span className={`badge badge-${item.status}`}>{badge}</span>
        <button type="button" className="small-button" onClick={onEdit} aria-label={`修改「${item.title}」的分类`}>
          改分类
        </button>
      </div>
      <div className="organize-row-detail">
        <div className="meta">{item.fromPath || '书签栏'}{item.targetPath ? ` → ${item.targetPath}` : ' → 保持原位'}</div>
        <div className="meta">{item.classification.reason}</div>
      </div>
      {expanded && (
        <div className="organize-row-expanded">
          <p className="host">{item.url}</p>
          <p className="meta">证据：{item.classification.evidence.join('；') || '无'}</p>
          <label className="field-label">
            目标文件夹
            <input
              aria-label={`修改「${item.title}」的目标文件夹`}
              value={item.targetPath ?? ''}
              placeholder="如 业务系统/某项目"
              onChange={(event) => onTargetChange(event.target.value)}
            />
          </label>
        </div>
      )}
    </div>
  );
}

type OverridePatch = { purpose: BookmarkPurpose; environment: BookmarkEnvironment; project: string; noAutoMove: boolean };

const buildOverrideEntry = (item: OrganizePlanItem, patch: OverridePatch): BookmarkOverride => ({
  bookmarkId: item.bookmarkId,
  urlFingerprint: item.urlFingerprint,
  purpose: patch.purpose,
  environment: patch.environment === 'unknown' ? undefined : patch.environment,
  project: patch.project || undefined,
  noAutoMove: patch.noAutoMove || undefined,
  updatedAt: Date.now(),
});

const buildScopeRule = (item: OrganizePlanItem, patch: OverridePatch, scope: 'host' | 'pathPrefix'): UserRule => {
  const host = item.host;
  const prefixSegment = new URL(item.url).pathname.split('/').find(Boolean) ?? '';
  return {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: scope,
    pattern: scope === 'host' ? host : `/${prefixSegment}`,
    ...(scope === 'pathPrefix' ? { host } : {}),
    purpose: patch.purpose,
    ...(patch.project ? { project: patch.project } : {}),
    ...(patch.environment !== 'unknown' ? { environment: patch.environment } : {}),
    enabled: true,
    createdAt: Date.now(),
  };
};

export function BookmarkOrganizePage({ active }: Props) {
  const [phase, setPhase] = useState<Phase>('scanning');
  const [preview, setPreview] = useState<OrganizePreview | null>(null);
  const [items, setItems] = useState<OrganizePlanItem[]>([]);
  const [scopeFolderId, setScopeFolderId] = useState<string | null>(null);
  const [folderOptions, setFolderOptions] = useState<FolderOption[]>([]);
  const [archiveEmpty, setArchiveEmpty] = useState(true);
  const [sourceTree, setSourceTree] = useState<chrome.bookmarks.BookmarkTreeNode[]>([]);
  const [aiKey, setAiKey] = useState('');
  const [showAiKey, setShowAiKey] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiStatus, setAiStatus] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [rowFilter, setRowFilter] = useState<RowFilter>('move');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [batch, setBatch] = useState<OrganizeBatch | null>(null);
  const [unfinished, setUnfinished] = useState<OrganizeBatch | null>(null);
  const [history, setHistory] = useState<OrganizeBatch[]>([]);
  const [settings, setSettings] = useState<OrganizerState['settings']>({ autoArchiveEnabled: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [organizerState, setOrganizerState] = useState<OrganizerState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const seq = useRef(0);
  const classificationRevisionRef = useRef<number | null>(null);
  const [repo] = useState(() => new ChromeOrganizerRepository());

  const rebuild = useCallback(async (nextScope: string | null): Promise<void> => {
    const ticket = ++seq.current;
    setPhase('scanning');
    setError(null);
    try {
      const [tree, state] = await Promise.all([chrome.bookmarks.getTree(), repo.load()]);
      if (ticket !== seq.current) return;
      const options: BuildPreviewOptions = {
        rules: state.rules,
        overrides: state.overrides,
        scopeFolderId: nextScope,
      };
      const nextPreview = buildOrganizePreview(tree, options);
      const snapshot = createBookmarkSnapshot(tree);
      const folders: FolderOption[] = [];
      for (const barRootId of snapshot.barRootIds) {
        // 多个书签栏根时允许按根选择；单根场景由「整个书签栏」选项覆盖。
        if (snapshot.barRootIds.length > 1) {
          folders.push({ id: barRootId, label: snapshot.nodes[barRootId]?.title || '书签栏' });
        }
        for (const folder of listFoldersInSubtree(snapshot, barRootId)) {
          folders.push({ id: folder.id, label: folder.relativeFolderPath || folder.title });
        }
      }
      setFolderOptions(folders);
      setSourceTree(tree);
      setPreview(nextPreview);
      setItems(nextPreview.items);
      classificationRevisionRef.current = state.classificationRevision;
      setOrganizerState(state);
      setSettings(state.settings);
      setUnfinished(state.batches.find((entry) => entry.status === 'running') ?? null);
      setHistory(state.batches.filter((entry) => entry.status === 'completed').sort((left, right) => right.startedAt - left.startedAt));
      setPhase('preview');
    } catch (cause) {
      if (ticket !== seq.current) return;
      setError(errorText(cause));
      setPhase('preview');
    }
  }, [repo]);

  // 进入整理页即扫描；storage 变化（批次进度、其他窗口写入）实时同步。
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void rebuild(scopeFolderId); });
    const refreshAiStatus = (): void => {
      void sendBookmarkCommand({ type: 'GET_BOOKMARK_AI_STATUS' }).then((response) => {
        if (!disposed && response.ok) {
          setAiConfigured(response.aiConfigured === true);
          if (response.autoOrganizeReady === false ||
            (typeof chrome.runtime.getManifest === 'function' && response.autoOrganizeReady === undefined)) {
            setAiStatus('自动整理后台尚未就绪，请在扩展管理页重新加载 DevPilot。');
          }
        }
      }).catch(() => { if (!disposed) setAiStatus('读取 AI 配置失败，请重新打开整理页。'); });
    };
    refreshAiStatus();
    const handleStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area === 'local' && changes[BOOKMARK_AI_KEY]) refreshAiStatus();
      if (area !== 'local' || !changes[ORGANIZER_STORAGE_KEY]) return;
      void (async (): Promise<void> => {
        const state = await repo.load();
        if (disposed) return;
        if (classificationRevisionRef.current !== null &&
          classificationRevisionRef.current !== state.classificationRevision) {
          // 另一窗口改了分类依据，旧预览的目标与默认勾选不能继续使用。
          void rebuild(scopeFolderId);
          return;
        }
        const running = state.batches.find((entry) => entry.status === 'running') ?? null;
        setUnfinished(running);
        setHistory(state.batches.filter((entry) => entry.status === 'completed').sort((left, right) => right.startedAt - left.startedAt));
        setSettings(state.settings);
        setOrganizerState(state);
        if (running) setBatch(running);
      })();
    };
    chrome.storage.onChanged.addListener(handleStorage);
    return () => {
      disposed = true;
      seq.current += 1;
      chrome.storage.onChanged.removeListener(handleStorage);
    };
  }, [active, rebuild, repo, scopeFolderId]);

  const changeScope = (folderId: string | null): void => {
    setScopeFolderId(folderId);
  };

  const visibleItems = useMemo(() => {
    if (rowFilter === 'all') return items;
    if (rowFilter === 'move') return items.filter((item) => item.status === 'move');
    return items.filter((item) => item.status === rowFilter);
  }, [items, rowFilter]);

  const selectedItems = useMemo(() => items.filter((item) => item.selected && item.targetPath), [items]);
  const cleanupCandidates = useMemo(() => emptyFolderCandidates(createBookmarkSnapshot(sourceTree), scopeFolderId,
    selectedItems.map((item) => ({ bookmarkId: item.bookmarkId, targetPath: item.targetPath! }))),
  [sourceTree, scopeFolderId, selectedItems]);

  const saveAiKey = async (clear = false): Promise<void> => {
    setBusy(true);
    setAiStatus('');
    try {
      const response = await sendBookmarkCommand({ type: 'SAVE_BOOKMARK_AI_KEY', apiKey: clear ? '' : aiKey });
      if (!response.ok) throw new Error(response.error);
      setAiConfigured(response.aiConfigured === true);
      setAiKey('');
      setShowAiKey(false);
      setAiStatus(clear ? '已移除 API Key。' : 'API Key 已保存在本机，可以生成 AI 整理预览。');
    } catch (cause) { setAiStatus(errorText(cause)); }
    finally { setBusy(false); }
  };

  const generateAi = async (): Promise<void> => {
    if (!organizerState) return;
    const ticket = ++seq.current;
    setBusy(true);
    setAiGenerating(true);
    setError(null);
    setAiStatus('正在使用 DeepSeek 分析所选范围的书签…');
    try {
      const response = await sendBookmarkCommand({ type: 'GENERATE_BOOKMARK_AI_PREVIEW', scopeFolderId,
        expectedRevision: organizerState.classificationRevision });
      if (ticket !== seq.current) return;
      if (!response.ok) throw new Error(response.error);
      if (!response.preview) throw new Error('未收到 AI 整理预览，请重试。');
      setPreview(response.preview);
      setItems(response.preview.items);
      setRowFilter('all');
      setAiStatus('AI 预览已生成。请检查目标目录后应用；待确认项需手动勾选。');
    } catch (cause) {
      if (ticket === seq.current) { setError(errorText(cause)); setAiStatus('AI 生成失败，可重试或继续使用当前预览。'); }
    } finally { setBusy(false); setAiGenerating(false); }
  };

  const toggleItem = (bookmarkId: string, selected: boolean): void => {
    setItems((current) => current.map((item) => item.bookmarkId === bookmarkId ? { ...item, selected } : item));
  };

  const changeTarget = (bookmarkId: string, path: string): void => {
    setItems((current) => current.map((item) => item.bookmarkId === bookmarkId ? { ...item, targetPath: path.trim() || null } : item));
  };

  const applyBatch = async (): Promise<void> => {
    if (selectedItems.length === 0 && !(archiveEmpty && cleanupCandidates.length > 0)) {
      setError('请先勾选要移动的书签。');
      return;
    }
    setBusy(true);
    setError(null);
    setPhase('applying');
    try {
      const plan = {
        classificationRevision: organizerState!.classificationRevision,
        items: selectedItems.map((item): PlannedMove => ({
          bookmarkId: item.bookmarkId,
          urlFingerprint: item.urlFingerprint,
          title: item.originalTitle,
          originalParentId: item.originalParentId,
          targetPath: item.targetPath!,
        })),
        archives: [],
        cleanupEmptyFolders: archiveEmpty,
        scopeFolderId,
      };
      const response = await sendBookmarkCommand({ type: 'APPLY_BOOKMARK_ORGANIZE', plan });
      if (!response.ok) throw new Error(response.error);
      setBatch(response.batch ?? null);
      setPhase('result');
      await rebuild(scopeFolderId);
      setPhase('result');
    } catch (cause) {
      setError(errorText(cause));
      setPhase('preview');
    } finally {
      setBusy(false);
    }
  };

  const runCommand = async (
    command: Parameters<typeof sendBookmarkCommand>[0],
    onSuccess?: (batch: OrganizeBatch | undefined) => void,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await sendBookmarkCommand(command);
      if (!response.ok) throw new Error(response.error);
      onSuccess?.(response.batch);
      if (response.batch) {
        // 批次类命令完成后回到结果视图（重建预览供后续操作）。
        setBatch(response.batch);
        await rebuild(scopeFolderId);
        setPhase('result');
      } else {
        if (command.type === 'SAVE_BOOKMARK_ORGANIZER_SETTINGS') {
          const state = await repo.load();
          setSettings(state.settings);
          setOrganizerState(state);
        } else await rebuild(scopeFolderId);
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveOverrideForItem = async (
    item: OrganizePlanItem,
    patch: OverridePatch,
    scope: 'item' | 'host' | 'pathPrefix',
  ): Promise<void> => {
    if (!organizerState) return;
    try {
      if (scope === 'item') {
        const overrides = { ...organizerState.overrides, [item.bookmarkId]: buildOverrideEntry(item, patch) };
        await runCommand({
          type: 'SAVE_BOOKMARK_ORGANIZER_OVERRIDES', overrides,
          expectedRevision: organizerState.classificationRevision,
        });
      } else {
        if (scope === 'host' && !item.host) {
          setError('该书签没有可用的域名，无法按域名保存规则。');
          return;
        }
        const rule = buildScopeRule(item, patch, scope);
        const affected = items.filter((other) => {
          try {
            const url = new URL(other.url);
            return scope === 'host'
              ? hostMatchesPattern(url.hostname, rule.pattern)
              : hostMatchesPattern(url.hostname, rule.host!) && pathMatchesPrefix(url.pathname, rule.pattern);
          } catch {
            return false;
          }
        });
        const confirmed = window.confirm(
          `该规则将影响当前预览中 ${affected.length} 条同${scope === 'host' ? '域名' : '路径前缀'}书签：\n${affected.slice(0, 3).map((entry) => entry.title).join('、')}${affected.length > 3 ? ' 等' : ''}\n确定保存？`,
        );
        if (!confirmed) return;
        await runCommand({
          type: 'SAVE_BOOKMARK_ORGANIZER_RULES', rules: [...organizerState.rules, rule],
          expectedRevision: organizerState.classificationRevision,
        });
      }
      setEditingId(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const undoBatch = (batchId: string): Promise<void> =>
    runCommand({ type: 'UNDO_BOOKMARK_ORGANIZE', batchId });

  const renderBatchResult = (target: OrganizeBatch) => {
    const applied = target.items.filter((item) => item.status === 'applied');
    const skipped = target.items.filter((item) => item.status === 'skipped');
    const failed = target.items.filter((item) => item.status === 'failed');
    return (
      <section className="organize-result" aria-label="批次结果">
        <div className="section-heading"><h2>批次结果</h2><span>{target.status === 'undone' ? '已撤销' : target.outcome === 'applied' ? '全部成功' : target.outcome === 'partial' ? '部分成功' : '未执行任何移动'}</span></div>
        <p className="copy-hint">成功 {applied.length} · 跳过 {skipped.length} · 失败 {failed.length}</p>
        {target.archivedFolders.length > 0 && <div className="organize-group">
          <h3>空目录处理</h3>
          {target.archivedFolders.map((folder) => <p className="meta" key={folder.folderId}>
            {folder.title || '未命名文件夹'} · {folder.status === 'applied' ? folder.mode === 'delete' ? '已删除' : '已存档' : folder.reason || '等待处理'}
          </p>)}
          {failed.length === 0 && target.archivedFolders.some((folder) => folder.status === 'failed') &&
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void runCommand({ type: 'RETRY_BOOKMARK_ORGANIZE', batchId: target.id })}>重试空目录清理</button>}
        </div>}
        {failed.length > 0 && (
          <div className="organize-group">
            <h3>失败</h3>
            {failed.map((item) => (
              <div key={item.bookmarkId} className="organize-row">
                <div className="organize-row-main"><strong>{item.title}</strong></div>
                <div className="meta">{item.reason}</div>
              </div>
            ))}
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void runCommand({ type: 'RETRY_BOOKMARK_ORGANIZE', batchId: target.id }, (next) => setBatch(next ?? target))}>
              重试失败项
            </button>
          </div>
        )}
        {skipped.length > 0 && (
          <div className="organize-group">
            <h3>跳过</h3>
            {skipped.map((item) => (
              <div key={item.bookmarkId} className="organize-row">
                <div className="organize-row-main"><strong>{item.title}</strong></div>
                <div className="meta">{item.reason}</div>
              </div>
            ))}
          </div>
        )}
        {target.undoReport.length > 0 && (
          <div className="organize-group">
            <h3>撤销时跳过</h3>
            {target.undoReport.map((entry) => (
              <div key={`${entry.kind}-${entry.id}`} className="organize-row"><div className="meta">{entry.reason}</div></div>
            ))}
          </div>
        )}
        <div className="button-row">
          {target.status === 'completed' && (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void undoBatch(target.id)}>
              撤销本批次
            </button>
          )}
          <button type="button" className="primary-button" disabled={busy} onClick={() => void rebuild(scopeFolderId)}>
            重新扫描
          </button>
        </div>
      </section>
    );
  };

  if (!active) return null;

  if (phase === 'scanning') {
    return <div className="empty-list">正在扫描书签并计算分类建议…</div>;
  }

  if (phase === 'applying') {
    const done = batch ? batch.items.filter((item) => item.status !== 'pending').length : 0;
    const total = batch ? batch.items.length : selectedItems.length;
    return <div className="empty-list" role="status">正在应用批次… {total > 0 ? `${done} / ${total}` : ''}</div>;
  }

  if (phase === 'result' && batch) {
    return <>{error && <div className="inline-error" role="alert">{error}</div>}{renderBatchResult(batch)}</>;
  }

  return (
    <div className="organize-page">
      {unfinished && (
        <div className="inline-error" role="alert">
          检测到未完成的整理批次（可能因浏览器关闭或扩展更新中断）。
          <button type="button" className="text-button" disabled={busy} onClick={() => void runCommand({ type: 'RECONCILE_BOOKMARK_ORGANIZE', batchId: unfinished.id }, (next) => { setBatch(next ?? null); setPhase('result'); })}>
            对账并恢复
          </button>
        </div>
      )}
      {error && <div className="inline-error" role="alert">{error}</div>}

      <section className="organize-settings organize-ai" aria-label="AI 整理设置">
        <div className="section-heading"><h2>AI 智能整理</h2><span>DeepSeek · {aiConfigured ? '已配置' : '未配置'}</span></div>
        <p className="copy-hint">默认使用 DeepSeek 官方接口（{DEEPSEEK_MODEL}），只需填写官方 API Key。</p>
        <form onSubmit={(event) => { event.preventDefault(); void saveAiKey(); }}>
          <div className="field-label">
            <label htmlFor="bookmark-ai-key">DeepSeek API Key</label>
            <div className="secret-input">
              <input id="bookmark-ai-key" type={showAiKey ? 'text' : 'password'} aria-label="DeepSeek API Key" autoComplete="off" spellCheck={false}
                value={aiKey} disabled={busy} placeholder={aiConfigured ? '已保存，输入新 Key 可替换' : 'sk-…'}
                onChange={(event) => setAiKey(event.target.value)} />
              <button type="button" className="secret-visibility" disabled={busy || !aiKey}
                aria-label={showAiKey ? '隐藏 API Key' : '显示 API Key'} aria-pressed={showAiKey}
                aria-controls="bookmark-ai-key" title={showAiKey ? '隐藏 API Key' : '显示 API Key'}
                onClick={() => setShowAiKey((current) => !current)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {showAiKey ? <>
                    <path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A12.3 12.3 0 0 1 12 5c6 0 10 7 10 7a18 18 0 0 1-3.2 3.9M6.3 6.3C3.6 8.2 2 12 2 12s4 7 10 7a11.7 11.7 0 0 0 5.7-1.7" />
                  </> : <>
                    <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </>}
                </svg>
              </button>
            </div>
          </div>
          <div className="button-row">
            <button type="submit" className="secondary-button" disabled={busy || !aiKey.trim()}>保存 Key</button>
            {aiConfigured && <button type="button" className="text-button" disabled={busy} onClick={() => void saveAiKey(true)}>移除 Key</button>}
            <button type="button" className="primary-button" disabled={busy || !aiConfigured || !preview || Boolean(unfinished)} onClick={() => void generateAi()}>
              {aiGenerating ? 'AI 正在分析…' : '生成 AI 整理预览'}
            </button>
          </div>
        </form>
        <label className="replacement-toggle organize-ai-toggle">
          <input type="checkbox" aria-label="新书签 AI 智能放置" checked={settings.aiAutoPlaceEnabled === true}
            disabled={busy || (!aiConfigured && !settings.aiAutoPlaceEnabled)} onChange={(event) => void runCommand({ type: 'SAVE_BOOKMARK_ORGANIZER_SETTINGS',
              settings: { aiAutoPlaceEnabled: event.target.checked } })} />
          收藏新网页时使用 AI 智能放置
        </label>
        <p className="copy-hint">开启后，通过浏览器星标或 Ctrl+D 新增到书签栏的书签会在名称稳定后智能放置；手动移动、删除和批量导入会停止处理。只有有把握的建议会自动应用，可在最近批次中撤销。</p>
        <p className="copy-hint">通常在收藏后 1.5 秒开始；后台补检约每 30 秒执行一次。AI 会按主题创建目录，并优先将同类收藏放入已有目录。</p>
        <button type="button" className="secondary-button full" disabled={busy || Boolean(unfinished) ||
          (!settings.aiAutoPlaceEnabled && !settings.autoArchiveEnabled)}
          onClick={() => void runCommand({ type: 'ORGANIZE_UNFILED_BOOKMARKS' })}>
          {busy ? '正在处理…' : '立即整理书签栏未归类收藏'}
        </button>
        <p className="copy-hint">此按钮补处理书签栏顶层已有的网页收藏；已放入文件夹、手动固定或指定过目录的书签会保留。</p>
        <div className="organize-activity" aria-label="自动整理状态" role="status" aria-live="polite">
          <h3>自动整理状态</h3>
          {organizerState?.activity.filter((entry) => entry.kind.startsWith('auto-')).slice(0, 4).map((entry, index) => (
            <p key={`${entry.at}-${index}`} className="meta">{entry.title} · {entry.detail}</p>
          ))}
          {!organizerState?.activity.some((entry) => entry.kind.startsWith('auto-')) &&
            <p className="meta">{settings.aiAutoPlaceEnabled || settings.autoArchiveEnabled
              ? '正在监听新收藏，尚未收到待整理书签。' : '开启自动放置后显示收到收藏、分类及放置结果。'}</p>}
        </div>
        <p className="copy-hint">AI 推荐、预览和自动放置会向 DeepSeek 发送书签标题、网址路径和目录；不发送网址查询参数与片段。Key 仅保存在本机。</p>
        {aiStatus && <p className="copy-hint" role="status">{aiStatus}</p>}
      </section>

      <div className="organize-controls">
        <label className="field-label">
          整理范围
          <select
            aria-label="选择整理范围"
            value={scopeFolderId ?? ''}
            disabled={busy}
            onChange={(event) => changeScope(event.target.value || null)}
          >
            <option value="">整个书签栏</option>
            {folderOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        {preview && preview.counts.move + preview.counts.keep + preview.counts.review + preview.counts.conflict > 0 && (
          <p className="copy-hint" role="status">
            移动 {preview.counts.move} · 保持 {preview.counts.keep} · 待确认 {preview.counts.review} · 冲突 {preview.counts.conflict}
            {preview.counts.pinned > 0 ? ` · 已固定 ${preview.counts.pinned}` : ''}
          </p>
        )}
      </div>

      {preview && (
        <section className="organize-preview" aria-label="整理预览" inert={aiGenerating}>
          <div className="section-heading">
            <h2>预览</h2>
            <span>{preview.summary.bookmarkCount} 条书签 · {preview.summary.folderCount} 个文件夹</span>
          </div>
          <div className="organize-filters" role="group" aria-label="筛选条目">
            {([['all', '全部'], ['move', '确定项'], ['review', '待确认'], ['conflict', '冲突']] as Array<[RowFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`chip${rowFilter === value ? ' active' : ''}`}
                aria-pressed={rowFilter === value}
                onClick={() => setRowFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {cleanupCandidates.length > 0 && (
            <label className="replacement-toggle organize-archive-toggle">
              <input type="checkbox" checked={archiveEmpty} disabled={busy} onChange={(event) => setArchiveEmpty(event.target.checked)} />
              删除整理后的 {cleanupCandidates.length} 个空文件夹（撤销时恢复）
            </label>
          )}

          {rowFilter === 'move' ? (
            groupPlanItemsByTarget(visibleItems).map((group) => (
              <div key={group.targetPath} className="organize-group">
                <h3>{group.targetPath} · {group.items.length} 条</h3>
                {group.items.map((item) => (
                  <PlanRow
                    key={item.bookmarkId}
                    item={item}
                    selectable
                    expanded={expandedId === item.bookmarkId}
                    onToggle={(selected) => toggleItem(item.bookmarkId, selected)}
                    onExpand={() => setExpandedId((current) => current === item.bookmarkId ? null : item.bookmarkId)}
                    onTargetChange={(path) => changeTarget(item.bookmarkId, path)}
                    onEdit={() => setEditingId(item.bookmarkId)}
                  />
                ))}
              </div>
            ))
          ) : (
            visibleItems.map((item) => (
              <PlanRow
                key={item.bookmarkId}
                item={item}
                selectable={item.status === 'move' || item.status === 'review' || item.status === 'conflict'}
                expanded={expandedId === item.bookmarkId}
                onToggle={(selected) => toggleItem(item.bookmarkId, selected)}
                onExpand={() => setExpandedId((current) => current === item.bookmarkId ? null : item.bookmarkId)}
                onTargetChange={(path) => changeTarget(item.bookmarkId, path)}
                onEdit={() => setEditingId(item.bookmarkId)}
              />
            ))
          )}
          {visibleItems.length === 0 && <div className="empty-list">当前筛选下没有条目。</div>}

          <div className="organize-apply">
            <button type="button" className="primary-button" disabled={busy || Boolean(unfinished) || (selectedItems.length === 0 && !(archiveEmpty && cleanupCandidates.length > 0))} onClick={() => void applyBatch()}>
              {selectedItems.length > 0 ? `应用选中的 ${selectedItems.length} 项` : '清理空文件夹'}
            </button>
            <p className="copy-hint">应用前后台会重新核对每条书签的位置与网址；只有确定项默认勾选，待确认与冲突必须手动选择。</p>
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="organize-history" aria-label="可撤销批次">
          <div className="section-heading"><h2>最近的批次</h2><span>{history.length}</span></div>
          {history.map((entry) => (
            <div key={entry.id} className="organize-row">
              <div className="organize-row-main">
                <strong>{new Date(entry.startedAt).toLocaleString()}</strong>
                <span className="meta">{entry.items.filter((item) => item.status === 'applied').length} 项已应用</span>
              </div>
              {entry.status === 'completed' && (
                <button type="button" className="small-button" disabled={busy} onClick={() => void undoBatch(entry.id)}>
                  撤销
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      {organizerState && (
        <section className="organize-settings" aria-label="自动归档设置">
          <label className="replacement-toggle">
            <input
              type="checkbox"
              checked={settings.autoArchiveEnabled}
              disabled={busy}
              onChange={(event) => void runCommand({ type: 'SAVE_BOOKMARK_ORGANIZER_SETTINGS', settings: { autoArchiveEnabled: event.target.checked } })}
            />
            对新书签自动应用我保存的规则（仅确定项）
          </label>
          {organizerState.activity.length > 0 && (
            <div className="organize-activity">
              <h3>最近自动整理记录</h3>
              {organizerState.activity.slice(0, 8).map((entry, index) => (
                <p key={`${entry.at}-${index}`} className="meta">{new Date(entry.at).toLocaleString()} · {entry.title} · {entry.detail}</p>
              ))}
            </div>
          )}
        </section>
      )}

      {editingId && (() => {
        const item = items.find((entry) => entry.bookmarkId === editingId);
        return item ? (
          <ClassificationEditor
            item={item}
            // onSave 只会在面板按钮的事件回调里执行，不会在渲染期间调用；
            // 其闭包链上的竞态序号 ref 对渲染无影响。
            // eslint-disable-next-line react-hooks/refs
            onSave={(patch, scope) => saveOverrideForItem(item, patch, scope)}
            onCancel={() => setEditingId(null)}
          />
        ) : null;
      })()}
    </div>
  );
}

/** 单条修正面板：只改此条，或保存为同域名/路径前缀规则（保存前列出会命中的条目）。 */
function ClassificationEditor({
  item, onSave, onCancel,
}: {
  item: OrganizePlanItem;
  onSave(patch: { purpose: BookmarkPurpose; environment: BookmarkEnvironment; project: string; noAutoMove: boolean }, scope: 'item' | 'host' | 'pathPrefix'): Promise<void>;
  onCancel(): void;
}) {
  const [purpose, setPurpose] = useState<BookmarkPurpose>(item.classification.purpose);
  const [environment, setEnvironment] = useState<BookmarkEnvironment>(item.classification.environment);
  const [project, setProject] = useState(item.classification.project === 'general' ? '' : item.classification.project);
  const [noAutoMove, setNoAutoMove] = useState(item.classification.noAutoMove);

  return (
    <div className="organize-editor" role="dialog" aria-label={`修改「${item.title}」的分类`}>
      <h3>修改分类：{item.title}</h3>
      <div className="organize-editor-grid">
        <label className="field-label">
          用途
          <select aria-label="用途" value={purpose} onChange={(event) => setPurpose(event.target.value as BookmarkPurpose)}>
            {PURPOSE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            <option value="unknown">待确认</option>
          </select>
        </label>
        <label className="field-label">
          环境
          <select aria-label="环境" value={environment} onChange={(event) => setEnvironment(event.target.value as BookmarkEnvironment)}>
            {ENVIRONMENT_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="field-label">
          项目（可选）
          <input aria-label="项目名称" value={project} onChange={(event) => setProject(event.target.value)} placeholder="留空表示通用" />
        </label>
      </div>
      <label className="replacement-toggle">
        <input type="checkbox" checked={noAutoMove} onChange={(event) => setNoAutoMove(event.target.checked)} />
        不要自动移动这条书签
      </label>
      <div className="button-row">
        <button type="button" className="primary-button" onClick={() => void onSave({ purpose, environment, project: project.trim(), noAutoMove }, 'item')}>
          仅修正此条
        </button>
        <button type="button" className="secondary-button" onClick={() => void onSave({ purpose, environment, project: project.trim(), noAutoMove }, 'host')}>
          按域名保存规则
        </button>
        <button type="button" className="secondary-button" onClick={() => void onSave({ purpose, environment, project: project.trim(), noAutoMove }, 'pathPrefix')}>
          按路径前缀保存规则
        </button>
        <button type="button" className="text-button" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}
