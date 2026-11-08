import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildOrganizePreview,
  groupPlanItemsByTarget,
  emptyFolderCandidates,
  canApplyPlanItem,
  describePlanRow,
  normalizePlanPath,
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
import { BOOKMARK_AI_CONFIG_KEY, aiPermissionOrigin, validateAiConfig } from '../../modules/bookmark-organizer/bookmark-ai-config';
import {
  sendBookmarkCommand,
  type PlannedMove,
} from '../../shared/messaging/bookmark-commands';
import { ChevronRightIcon, CloseIcon } from '../components/icons';

type Phase = 'scanning' | 'preview' | 'applying' | 'result';

type RowFilter = 'all' | 'move' | 'review' | 'conflict';

const PREVIEW_PAGE_SIZE = 10;
const PREVIEW_FILTERS: { value: RowFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'move', label: '确定项' },
  { value: 'review', label: '待确认' },
  { value: 'conflict', label: '冲突' },
];

interface FolderOption {
  id: string;
  label: string;
}

interface Props {
  active: boolean;
  onBack?(): void;
  onDirtyChange?(dirty: boolean): void;
}

const PURPOSE_OPTIONS = Object.entries(PURPOSE_LABELS) as Array<[Exclude<BookmarkPurpose, 'unknown'>, string]>;
const ENVIRONMENT_OPTIONS: BookmarkEnvironment[] = ['prod', 'pre', 'demo', 'test', 'unknown'];
const errorText = (error: unknown): string => (error instanceof Error ? error.message : '操作失败');

/** 单条书签行：勾选、理由、可展开的完整信息与目标编辑。 */
function PlanRow({
  item, expanded, editing, onToggle, onExpand, onTargetChange, onEdit,
}: {
  item: OrganizePlanItem;
  expanded: boolean;
  editing: boolean;
  onToggle(selected: boolean): void;
  onExpand(): void;
  onTargetChange(path: string): void;
  onEdit(): void;
}) {
  const row = describePlanRow(item);
  const stateId = `organize-row-state-${item.bookmarkId}`;
  const checkboxRef = useRef<HTMLInputElement>(null);
  return (
    <div className={`organize-row${item.selected && row.selectable ? ' selected' : ''}${editing ? ' editing' : ''}`} data-bookmark-id={item.bookmarkId}>
      <div className="organize-row-main">
        {row.selectable ? (
          <input
            ref={checkboxRef}
            type="checkbox"
            aria-label={`选择「${item.title}」`}
            aria-describedby={stateId}
            checked={item.selected}
            onChange={(event) => onToggle(event.target.checked)}
          />
        ) : (
          <span className="organize-row-dash" aria-hidden="true">—</span>
        )}
        <button type="button" className="organize-row-title text-button" onClick={onExpand} aria-expanded={expanded}>
          <span className="organize-row-title-text">
            <strong>{item.title}</strong>
            <span className="meta">{item.host}</span>
          </span>
          <ChevronRightIcon className={`organize-row-chevron${expanded ? ' expanded' : ''}`} aria-hidden="true" />
        </button>
        <span className={`badge badge-${row.badgeStatus}`}>{row.badge}</span>
        {row.showSelectionTag && <span className="organize-row-selection">已选入批次</span>}
        {row.canAdopt && (
          <button
            type="button"
            className="small-button organize-row-confirm"
            aria-label={`采用「${item.title}」的目标目录`}
            onClick={() => {
              onToggle(true);
              // 等状态提交后再聚焦，让读屏读到更新后的选择状态，也避免焦点落回页面顶部。
              globalThis.requestAnimationFrame(() => checkboxRef.current?.focus());
            }}
          >
            采用目标
          </button>
        )}
        <span id={stateId} className="visually-hidden">{row.stateText}</span>
        <button type="button" className="text-button organize-row-edit" onClick={onEdit} aria-label={`修改「${item.title}」的分类`}>
          改分类
        </button>
      </div>
      <div className="organize-row-detail">
        <div className="meta">{row.targetText}</div>
        {row.hint && <div className="meta organize-row-hint">{row.hint}</div>}
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
              onBlur={() => onTargetChange((item.targetPath ?? '').trim())}
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

export function BookmarkOrganizePage({ active, onBack, onDirtyChange }: Props) {
  const [phase, setPhase] = useState<Phase>('scanning');
  const [preview, setPreview] = useState<OrganizePreview | null>(null);
  const [previewSource, setPreviewSource] = useState<'rules' | 'ai'>('rules');
  const [items, setItems] = useState<OrganizePlanItem[]>([]);
  const [scopeFolderId, setScopeFolderId] = useState<string | null>(null);
  const [folderOptions, setFolderOptions] = useState<FolderOption[]>([]);
  // 默认一并清理范围内空目录；用户可取消，撤销批次时恢复。
  const [archiveEmpty, setArchiveEmpty] = useState(true);
  const [sourceTree, setSourceTree] = useState<chrome.bookmarks.BookmarkTreeNode[]>([]);
  const [aiKey, setAiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [showAiKey, setShowAiKey] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiStatus, setAiStatus] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [pendingChanges, setPendingChanges] = useState(false);
  const [rowFilter, setRowFilter] = useState<RowFilter>('move');
  const [page, setPage] = useState(1);
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
  const previewPaging = useRef<HTMLElement>(null);
  const editTriggerRef = useRef<HTMLElement | null>(null);
  const focusRestoreRef = useRef<{ bookmarkId: string; trigger: HTMLElement | null } | null>(null);
  const savingOverrideRef = useRef(false);
  const classificationRevisionRef = useRef<number | null>(null);
  /** 保存修正后重建预览时，按书签 ID 保留用户亲手改过的勾选、目标和当前页。 */
  const preserveEditsRef = useRef<{
    items: Map<string, { selected: boolean; targetPath: string | null; selectionTouched: boolean; targetTouched: boolean }>;
    affected: Set<string>;
    page: number;
  } | null>(null);
  const touchedSelectionRef = useRef<Set<string>>(new Set());
  const touchedTargetRef = useRef<Set<string>>(new Set());
  // 本页保存规则/覆盖会推高分类版本；由命令完成后的重建同步，不能再按“外部改动”清空勾选。
  const localRevisionWriteRef = useRef(false);
  const [repo] = useState(() => new ChromeOrganizerRepository());
  // 条目可能因外部书签变化从预览中消失；面板只跟随仍存在的条目，避免残留的 editingId 阻塞返回。
  const editingItem = editingId ? items.find((entry) => entry.bookmarkId === editingId) ?? null : null;

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
      const preserved = preserveEditsRef.current;
      preserveEditsRef.current = null;
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
      setPreviewSource('rules');
      setItems(preserved
        ? nextPreview.items.map((item) => {
          const local = preserved.items.get(item.bookmarkId);
          if (!local) return item;
          return {
            ...item,
            // 只保留用户亲手改过的状态，避免把 AI 默认建议带进规则预览。
            selected: local.selectionTouched ? local.selected : item.selected,
            ...(local.targetTouched && !preserved.affected.has(item.bookmarkId) ? { targetPath: local.targetPath } : {}),
          };
        })
        : nextPreview.items);
      setPage(preserved ? preserved.page : 1);
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
          if (response.aiConfig) { setBaseUrl(response.aiConfig.baseUrl); setModel(response.aiConfig.model); }
          if (response.autoOrganizeReady === false ||
            (typeof chrome.runtime.getManifest === 'function' && response.autoOrganizeReady === undefined)) {
            setAiStatus('自动整理后台尚未就绪，请在扩展管理页重新加载 DevPilot。');
          }
        }
      }).catch(() => { if (!disposed) setAiStatus('读取 AI 配置失败，请重新打开整理页。'); });
    };
    refreshAiStatus();
    const handleStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area === 'local' && changes[BOOKMARK_AI_CONFIG_KEY]) refreshAiStatus();
      if (area !== 'local' || !changes[ORGANIZER_STORAGE_KEY]) return;
      void (async (): Promise<void> => {
        const state = await repo.load();
        if (disposed) return;
        if (classificationRevisionRef.current !== null &&
          classificationRevisionRef.current !== state.classificationRevision) {
          if (localRevisionWriteRef.current) return;
          // 另一窗口改了分类依据，旧预览的目标与默认勾选不能继续使用。
          touchedSelectionRef.current.clear();
          touchedTargetRef.current.clear();
          setPendingChanges(false);
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

  // Esc 层级：分类面板优先处理（由其自身监听），否则返回书签搜索；扫描和应用期间不打断。
  useEffect(() => {
    if (!active || !onBack) return;
    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing || editingItem) return;
      if (phase !== 'preview' && phase !== 'result') return;
      event.preventDefault();
      onBack();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [active, editingItem, onBack, phase]);

  // 让子页头在返回或关闭前判断是否有未应用的勾选与 AI 预览。
  useEffect(() => {
    onDirtyChange?.(pendingChanges);
  }, [onDirtyChange, pendingChanges]);

  const changeScope = (folderId: string | null): void => {
    setScopeFolderId(folderId);
    // 新范围重新计算空目录与勾选，默认清理新范围内的空目录。
    setArchiveEmpty(true);
    setExpandedId(null);
    setEditingId(null);
    setPage(1);
    touchedSelectionRef.current.clear();
    touchedTargetRef.current.clear();
    preserveEditsRef.current = null;
    setAiStatus('');
    setPendingChanges(false);
  };

  /** 主动重扫表示用户接受新计划：清掉仅本地保存的勾选与目标修改。 */
  const rescanPreview = (): void => {
    touchedSelectionRef.current.clear();
    touchedTargetRef.current.clear();
    preserveEditsRef.current = null;
    setAiStatus('');
    setPendingChanges(false);
    void rebuild(scopeFolderId);
  };

  const visibleItems = useMemo(() => {
    if (rowFilter === 'all') return items;
    if (rowFilter === 'move') return groupPlanItemsByTarget(items).flatMap((group) => group.items);
    return items.filter((item) => item.status === rowFilter);
  }, [items, rowFilter]);
  const filterCounts = { all: items.length, move: 0, review: 0, conflict: 0 };
  for (const item of items) {
    if (item.status === 'review' || item.status === 'conflict') filterCounts[item.status] += 1;
    if (item.status === 'move' && canApplyPlanItem(item)) filterCounts.move += 1;
  }
  const pageCount = Math.max(1, Math.ceil(visibleItems.length / PREVIEW_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * PREVIEW_PAGE_SIZE;
  const pageItems = visibleItems.slice(pageStart, pageStart + PREVIEW_PAGE_SIZE);

  const renderPagination = (position: 'top' | 'bottom') => (
    <nav className="organize-pagination" aria-label={position === 'top' ? '预览分页' : '列表底部分页'}
      ref={position === 'top' ? previewPaging : undefined} tabIndex={position === 'top' ? -1 : undefined}>
      <div className="organize-page-summary" role={position === 'top' ? 'status' : undefined}>
        <strong>第 {currentPage} / {pageCount} 页</strong>
        <span>第 {pageStart + 1}–{pageStart + pageItems.length} 条，共 {visibleItems.length} 条</span>
      </div>
      <div className="organize-page-buttons">
        <button type="button" className="small-button" disabled={currentPage === 1} onClick={() => {
          setPage(currentPage - 1);
          if (position === 'bottom') previewPaging.current?.focus();
        }}>上一页</button>
        <button type="button" className="small-button" disabled={currentPage === pageCount} onClick={() => {
          setPage(currentPage + 1);
          if (position === 'bottom') previewPaging.current?.focus();
        }}>下一页</button>
      </div>
    </nav>
  );

  const selectedItems = useMemo(() => items.filter((item) => item.selected && canApplyPlanItem(item)), [items]);
  const cleanupCandidates = useMemo(() => emptyFolderCandidates(createBookmarkSnapshot(sourceTree), scopeFolderId,
    selectedItems.map((item) => ({ bookmarkId: item.bookmarkId, targetPath: normalizePlanPath(item.targetPath) }))),
  [sourceTree, scopeFolderId, selectedItems]);

  const saveAiKey = async (clear = false): Promise<void> => {
    setBusy(true);
    setAiStatus('');
    try {
      if (!clear) {
        validateAiConfig({ baseUrl, model, apiKey: aiKey });
        if (!await chrome.permissions.request({ origins: [aiPermissionOrigin(baseUrl)] })) throw new Error('未获得服务访问权限，配置尚未保存。');
      }
      const response = await sendBookmarkCommand(clear ? { type: 'CLEAR_BOOKMARK_AI_CONFIG' } : {
        type: 'SAVE_BOOKMARK_AI_CONFIG', config: { baseUrl, model, ...(aiKey.trim() ? { apiKey: aiKey } : {}) },
      });
      if (!response.ok) throw new Error(response.error);
      setAiConfigured(response.aiConfigured === true);
      setAiKey('');
      setShowAiKey(false);
      setAiSettingsOpen(false);
      setAiStatus(clear ? '已移除 AI 配置并关闭自动分类。' : 'AI 配置已保存在本机，可以生成整理预览。');
    } catch (cause) { setAiStatus(errorText(cause)); }
    finally { setBusy(false); }
  };

  const generateAi = async (): Promise<void> => {
    if (!organizerState) return;
    const ticket = ++seq.current;
    setBusy(true);
    setAiGenerating(true);
    setError(null);
    setAiStatus('正在分析所选范围的书签…');
    try {
      const response = await sendBookmarkCommand({ type: 'GENERATE_BOOKMARK_AI_PREVIEW', scopeFolderId,
        expectedRevision: organizerState.classificationRevision });
      if (ticket !== seq.current) return;
      if (!response.ok) throw new Error(response.error);
      if (!response.preview) throw new Error('未收到 AI 整理预览，请重试。');
      setPreview(response.preview);
      setPreviewSource('ai');
      setItems(response.preview.items);
      setRowFilter('all');
      setPage(1);
      touchedSelectionRef.current.clear();
      touchedTargetRef.current.clear();
      setPendingChanges(true);
      setAiStatus('AI 预览已生成。请检查目标目录后应用；有建议但待采用的条目需手动勾选。');
    } catch (cause) {
      if (ticket === seq.current) { setError(errorText(cause)); setAiStatus('AI 生成失败，可重试或继续使用当前预览。'); }
    } finally { setBusy(false); setAiGenerating(false); }
  };

  const toggleItem = (bookmarkId: string, selected: boolean): void => {
    touchedSelectionRef.current.add(bookmarkId);
    const nextItems = items.map((item) => {
      if (item.bookmarkId !== bookmarkId) return item;
      // 没有可执行目标的条目不能进入批次，避免选中数与后台实际移动数不一致。
      return canApplyPlanItem(item) ? { ...item, selected } : item;
    });
    setItems(nextItems);
    // 规则预览没有默认勾选的待采用项；采用后撤销不应留下“有未应用改动”的误报。
    const cleanupPending = archiveEmpty && cleanupCandidates.length > 0;
    const unchangedSelection = previewSource === 'rules' && !cleanupPending && touchedTargetRef.current.size === 0
      && nextItems.every((item) => item.selected === (item.status === 'move'));
    setPendingChanges(!unchangedSelection);
  };

  const changeTarget = (bookmarkId: string, path: string): void => {
    // 保留输入过程中的空格，失焦或应用时再 trim，避免无法输入含空格的目录名。
    touchedTargetRef.current.add(bookmarkId);
    setPendingChanges(true);
    setItems((current) => current.map((item) => {
      if (item.bookmarkId !== bookmarkId) return item;
      const next = { ...item, targetPath: path || null };
      // 目标被清空或改回当前目录后，旧勾选已失效，必须退出批次。
      return canApplyPlanItem(next) ? next : { ...next, selected: false };
    }));
  };

  const openEditor = (bookmarkId: string): void => {
    editTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingId(bookmarkId);
  };

  /** 记录关闭前的行；重建会卸载旧按钮，等新预览提交后再恢复焦点。 */
  const closeEditor = (): void => {
    focusRestoreRef.current = editingItem ? { bookmarkId: editingItem.bookmarkId, trigger: editTriggerRef.current } : null;
    setEditingId(null);
  };

  // 保存修正会短暂切到扫描态并重建整行；只在新预览可用后恢复焦点。
  useEffect(() => {
    const pending = focusRestoreRef.current;
    if (!pending || editingId !== null || phase !== 'preview' || busy) return;
    focusRestoreRef.current = null;
    const row = globalThis.document.querySelector<HTMLElement>(`[data-bookmark-id="${CSS.escape(pending.bookmarkId)}"]`);
    const target = row?.querySelector<HTMLElement>('.organize-row-edit')
      ?? (pending.trigger?.isConnected ? pending.trigger : null)
      ?? previewPaging.current
      ?? globalThis.document.querySelector<HTMLElement>('.organize-preview .chip')
      ?? globalThis.document.querySelector<HTMLElement>('.organize-hero select');
    target?.focus();
  }, [busy, editingId, phase]);

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
          targetPath: normalizePlanPath(item.targetPath),
        })),
        archives: [],
        cleanupEmptyFolders: archiveEmpty,
        scopeFolderId,
      };
      const response = await sendBookmarkCommand({ type: 'APPLY_BOOKMARK_ORGANIZE', plan });
      if (!response.ok) throw new Error(response.error);
      setBatch(response.batch ?? null);
      setPhase('result');
      touchedSelectionRef.current.clear();
      touchedTargetRef.current.clear();
      setPendingChanges(false);
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
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const response = await sendBookmarkCommand(command);
      if (!response.ok) throw new Error(response.error);
      onSuccess?.(response.batch);
      if (response.batch) {
        // 批次类命令完成后回到结果视图（重建预览供后续操作）。
        setBatch(response.batch);
        touchedSelectionRef.current.clear();
        touchedTargetRef.current.clear();
        setPendingChanges(false);
        await rebuild(scopeFolderId);
        setPhase('result');
      } else {
        if (command.type === 'SAVE_BOOKMARK_ORGANIZER_SETTINGS') {
          const state = await repo.load();
          setSettings(state.settings);
          setOrganizerState(state);
        } else await rebuild(scopeFolderId);
      }
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** 重建前记录当前勾选与手改目标，避免保存单条修正后丢失其他行的操作。 */
  const rememberPreviewEdits = (affected: Set<string>): void => {
    // 本次规则覆盖到的条目不再保留旧的手改结果；其余条目保留用户亲手改过的状态。
    for (const id of affected) {
      touchedSelectionRef.current.delete(id);
      touchedTargetRef.current.delete(id);
    }
    preserveEditsRef.current = {
      items: new Map(items.map((entry) => [entry.bookmarkId, {
        selected: entry.selected,
        targetPath: entry.targetPath,
        selectionTouched: touchedSelectionRef.current.has(entry.bookmarkId),
        targetTouched: touchedTargetRef.current.has(entry.bookmarkId),
      }])),
      affected,
      page: currentPage,
    };
  };

  const saveOverrideForItem = async (
    item: OrganizePlanItem,
    patch: OverridePatch,
    scope: 'item' | 'host' | 'pathPrefix',
  ): Promise<void> => {
    if (!organizerState || savingOverrideRef.current) return;
    savingOverrideRef.current = true;
    const wasAi = previewSource === 'ai';
    localRevisionWriteRef.current = true;
    try {
      let saved = false;
      if (scope === 'item') {
        rememberPreviewEdits(new Set([item.bookmarkId]));
        const overrides = { ...organizerState.overrides, [item.bookmarkId]: buildOverrideEntry(item, patch) };
        saved = await runCommand({
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
        rememberPreviewEdits(new Set(affected.map((entry) => entry.bookmarkId)));
        saved = await runCommand({
          type: 'SAVE_BOOKMARK_ORGANIZER_RULES', rules: [...organizerState.rules, rule],
          expectedRevision: organizerState.classificationRevision,
        });
      }
      // 保存失败时保留面板和输入，错误同时显示在面板内和页面顶部。
      if (!saved) preserveEditsRef.current = null;
      if (saved) {
        closeEditor();
        if (wasAi) setAiStatus('已保存修正，并切换为规则预览；如需 AI 建议请重新生成。');
      }
    } catch (cause) {
      preserveEditsRef.current = null;
      setError(errorText(cause));
    } finally {
      localRevisionWriteRef.current = false;
      savingOverrideRef.current = false;
    }
  };

  const undoBatch = (batchId: string): Promise<boolean> =>
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
          <button type="button" className="primary-button" disabled={busy} onClick={rescanPreview}>
            重新扫描
          </button>
        </div>
      </section>
    );
  };

  /** AI 服务表单：未配置时直接展示，配置后收进设置折叠区。 */
  const renderAiForm = () => (
    <form className="organize-ai-form" onSubmit={(event) => { event.preventDefault(); void saveAiKey(); }}>
      <label className="field-label">服务地址<input aria-label="AI 服务地址" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://your-service.example/v1" disabled={busy} /></label>
      <label className="field-label">模型名称<input aria-label="AI 模型名称" value={model} onChange={(event) => setModel(event.target.value)} placeholder="填写服务提供的模型名称" disabled={busy} /></label>
      <div className="field-label">
        <label htmlFor="bookmark-ai-key">API Key（服务不需要时可留空）</label>
        <div className="secret-input">
          <input id="bookmark-ai-key" type={showAiKey ? 'text' : 'password'} aria-label="API Key" autoComplete="off" spellCheck={false}
            value={aiKey} disabled={busy} placeholder={aiConfigured ? '留空保留同一地址的已存 Key' : '填写 API Key'}
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
        <button type="submit" className={aiConfigured ? 'secondary-button' : 'primary-button'} disabled={busy || !baseUrl.trim() || !model.trim()}>保存配置</button>
        {aiConfigured && <button type="button" className="text-button" disabled={busy} onClick={() => void saveAiKey(true)}>移除配置</button>}
      </div>
    </form>
  );

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
        <div className="inline-error" role="alert" inert={Boolean(editingItem)}>
          检测到未完成的整理批次（可能因浏览器关闭或扩展更新中断）。
          <button type="button" className="text-button" disabled={busy} onClick={() => void runCommand({ type: 'RECONCILE_BOOKMARK_ORGANIZE', batchId: unfinished.id }, (next) => { setBatch(next ?? null); setPhase('result'); })}>
            对账并恢复
          </button>
        </div>
      )}
      {error && <div className="inline-error" role="alert">{error}</div>}

      <section className="organize-hero" aria-label="整理操作" inert={Boolean(editingItem)}>
        <div className="section-heading">
          <h2>AI 智能整理</h2>
          <span className={`badge ${aiConfigured ? 'badge-pinned' : 'badge-review'}`}>{aiConfigured ? '已连接' : '未配置'}</span>
        </div>
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
        {aiConfigured ? (
          <div className="button-row">
            <button type="button" className="primary-button" disabled={busy || Boolean(unfinished)} onClick={() => void generateAi()}>
              {aiGenerating ? 'AI 正在分析…' : '生成 AI 整理预览'}
            </button>
          </div>
        ) : (
          <p className="copy-hint">配置下方 AI 服务后可生成 AI 预览；不配置也可以直接使用规则预览。</p>
        )}
        {aiConfigured && (
          <label className="replacement-toggle organize-ai-toggle">
            <input type="checkbox" aria-label="新书签 AI 智能放置" checked={settings.aiAutoPlaceEnabled === true}
              disabled={busy} onChange={(event) => void runCommand({ type: 'SAVE_BOOKMARK_ORGANIZER_SETTINGS',
                settings: { aiAutoPlaceEnabled: event.target.checked } })} />
            收藏新网页时使用 AI 智能放置
          </label>
        )}
        <details className="organize-ai-settings" open={aiSettingsOpen} onToggle={(event) => setAiSettingsOpen(event.currentTarget.open)}>
          <summary>AI 服务设置（可选）{aiConfigured && <span className="meta">{model || '已保存'}{baseUrl ? ` · ${baseUrl}` : ''}</span>}</summary>
          <p className="copy-hint">支持 OpenAI 兼容接口；地址可填到 /v1 或完整 /chat/completions，服务不需要 Key 时可留空。</p>
          {renderAiForm()}
        </details>
        <details className="organize-more">
          <summary>自动整理说明与更多设置</summary>
          <p className="replacement-help">开启「收藏新网页时使用 AI 智能放置」后，通过星标或 Ctrl+D 新增到书签栏顶层的书签会在短暂等待后自动放置；修改名称会重新判断，手动移动、删除和批量导入会停止处理。只有有把握的建议会自动应用，可在最近批次中撤销。</p>
          <p className="replacement-help">后台休眠后，会通过定时任务继续处理已记录的新收藏。AI 按主题创建目录，并优先放入已有目录。</p>
          <button type="button" className="secondary-button full" disabled={busy || Boolean(unfinished) ||
            (!settings.aiAutoPlaceEnabled && !settings.autoArchiveEnabled)}
            onClick={() => {
              if (window.confirm('将按已保存的规则和 AI 设置整理书签栏顶层的未归类收藏，确定继续？')) {
                void runCommand({ type: 'ORGANIZE_UNFILED_BOOKMARKS' });
              }
            }}>
            {busy ? '正在处理…' : '立即整理书签栏未归类收藏'}
          </button>
          {!settings.aiAutoPlaceEnabled && !settings.autoArchiveEnabled && (
            <p className="replacement-help">先开启上方 AI 放置或下方规则自动应用，才能使用一键补整理。</p>
          )}
          <p className="replacement-help">补处理书签栏顶层已有的网页收藏；已放入文件夹、手动固定或指定过目录的书签会保留。</p>
          <label className="replacement-toggle">
            <input
              type="checkbox"
              checked={settings.autoArchiveEnabled}
              disabled={busy}
              onChange={(event) => void runCommand({ type: 'SAVE_BOOKMARK_ORGANIZER_SETTINGS', settings: { autoArchiveEnabled: event.target.checked } })}
            />
            对新书签自动应用我保存的规则（仅确定项）
          </label>
          <div className="organize-activity" aria-label="最近自动整理记录" role="status" aria-live="polite">
            <h3>最近整理记录</h3>
            {organizerState?.activity.slice(0, 6).map((entry, index) => (
              <p key={`${entry.at}-${index}`} className="meta">{new Date(entry.at).toLocaleString()} · {entry.title} · {entry.detail}</p>
            ))}
            {!organizerState?.activity.length &&
              <p className="meta">开启自动放置后显示收到收藏、分类及放置结果。</p>}
          </div>
          <p className="replacement-help">AI 推荐、预览和自动放置会向你配置的 AI 服务发送书签标题、网址路径、目录及少量已有书签样例；不发送网址查询参数与片段。Key 仅保存在本机。</p>
        </details>
      </section>

      {aiStatus && <p className="organize-status" role="status">{aiStatus}</p>}

      {preview && (
        <section className="organize-preview" aria-label="整理预览" inert={aiGenerating || Boolean(editingItem)}>
          <div className="section-heading">
            <h2>整理预览</h2>
            <span>{previewSource === 'ai' ? 'AI 建议' : '规则建议'} · {preview.summary.bookmarkCount} 条书签 · {preview.summary.folderCount} 个文件夹</span>
            <button type="button" className="text-button preview-refresh" disabled={busy || Boolean(unfinished)} onClick={rescanPreview}>重新扫描</button>
          </div>
          <div className="organize-filters" role="group" aria-label="按分类状态筛选">
            <span className="organize-filter-label">筛选</span>
            {PREVIEW_FILTERS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={`chip${rowFilter === value ? ' active' : ''}`}
                aria-pressed={rowFilter === value}
                onClick={() => { setRowFilter(value); setPage(1); }}
              >
                {label} {filterCounts[value]}
              </button>
            ))}
          </div>
          {cleanupCandidates.length > 0 && (
            <label className="replacement-toggle organize-archive-toggle">
              <input type="checkbox" checked={archiveEmpty} disabled={busy} onChange={(event) => { setPendingChanges(true); setArchiveEmpty(event.target.checked); }} />
              删除范围内 {cleanupCandidates.length} 个空文件夹（撤销时恢复）
            </label>
          )}

          {pageItems.length > 0 && renderPagination('top')}
          {rowFilter === 'move' ? (
            groupPlanItemsByTarget(pageItems).map((group) => (
              <div key={group.targetPath} className="organize-group">
                <h3>{group.targetPath} · 本页 {group.items.length} 条</h3>
                {group.items.map((item) => (
                  <PlanRow
                    key={item.bookmarkId}
                    item={item}
                    expanded={expandedId === item.bookmarkId}
                    editing={editingId === item.bookmarkId}
                    onToggle={(selected) => toggleItem(item.bookmarkId, selected)}
                    onExpand={() => setExpandedId((current) => current === item.bookmarkId ? null : item.bookmarkId)}
                    onTargetChange={(path) => changeTarget(item.bookmarkId, path)}
                    onEdit={() => openEditor(item.bookmarkId)}
                  />
                ))}
              </div>
            ))
          ) : (
            pageItems.map((item) => (
              <PlanRow
                key={item.bookmarkId}
                item={item}
                expanded={expandedId === item.bookmarkId}
                editing={editingId === item.bookmarkId}
                onToggle={(selected) => toggleItem(item.bookmarkId, selected)}
                onExpand={() => setExpandedId((current) => current === item.bookmarkId ? null : item.bookmarkId)}
                onTargetChange={(path) => changeTarget(item.bookmarkId, path)}
                onEdit={() => openEditor(item.bookmarkId)}
              />
            ))
          )}
          {visibleItems.length === 0 && <div className="empty-list">{items.length === 0 ? '当前范围内没有可整理的书签。' : '当前筛选下没有条目。'}</div>}
          {pageCount > 1 && renderPagination('bottom')}

          <div className="organize-apply">
            <button type="button" className="primary-button" disabled={busy || Boolean(unfinished) || (selectedItems.length === 0 && !(archiveEmpty && cleanupCandidates.length > 0))} onClick={() => void applyBatch()}>
              {selectedItems.length > 0 ? `应用选中的 ${selectedItems.length} 项` : '清理空文件夹'}
            </button>
            <p className="copy-hint">应用范围包含所有页面中已选入批次的条目。后台会重新核对每条书签的位置与网址；无目标或目标仍在原位的条目不会移动。</p>
          </div>
        </section>
      )}

      {history.length > 0 && (
        <details className="organize-history" inert={Boolean(editingItem)}>
          <summary>最近的批次 <span className="section-count">{history.length}</span></summary>
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
        </details>
      )}

      {editingItem && (
        <div className="organize-editor-shell">
          <div className="organize-editor-backdrop" aria-hidden="true" onClick={() => { if (!busy) closeEditor(); }} />
          <ClassificationEditor
            item={editingItem}
            busy={busy}
            error={error}
            // onSave 只会在面板按钮的事件回调里执行，不会在渲染期间调用。
            onSave={(patch, scope) => saveOverrideForItem(editingItem, patch, scope)}
            onCancel={closeEditor}
          />
        </div>
      )}
    </div>
  );
}

/** 单条修正面板：只改此条，或保存为同域名/路径前缀规则（保存前列出会命中的条目）。 */
function ClassificationEditor({
  item, busy, error, onSave, onCancel,
}: {
  item: OrganizePlanItem;
  busy: boolean;
  error: string | null;
  onSave(patch: { purpose: BookmarkPurpose; environment: BookmarkEnvironment; project: string; noAutoMove: boolean }, scope: 'item' | 'host' | 'pathPrefix'): Promise<void>;
  onCancel(): void;
}) {
  const [purpose, setPurpose] = useState<BookmarkPurpose>(item.classification.purpose);
  const [environment, setEnvironment] = useState<BookmarkEnvironment>(item.classification.environment);
  const [project, setProject] = useState(item.classification.project === 'general' ? '' : item.classification.project);
  const [noAutoMove, setNoAutoMove] = useState(item.classification.noAutoMove);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.body.classList.add('organize-modal-open');
    return () => document.body.classList.remove('organize-modal-open');
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        if (!busy) onCancel();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusables = [...dialog.querySelectorAll<HTMLElement>('button, select, input')]
        .filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel]);

  return (
    <div ref={dialogRef} className="organize-editor" role="dialog" aria-modal="true" aria-busy={busy} aria-label={`修改「${item.title}」的分类`}>
      <div className="organize-editor-head">
        <h3>修改分类：{item.title}</h3>
        <button type="button" className="icon-button organize-editor-close" disabled={busy} onClick={onCancel} aria-label="取消修改分类">
          <CloseIcon />
        </button>
      </div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="organize-editor-grid">
        <label className="field-label">
          用途
          <select aria-label="用途" autoFocus disabled={busy} value={purpose} onChange={(event) => setPurpose(event.target.value as BookmarkPurpose)}>
            {PURPOSE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            <option value="unknown">待确认</option>
          </select>
        </label>
        <label className="field-label">
          环境
          <select aria-label="环境" disabled={busy} value={environment} onChange={(event) => setEnvironment(event.target.value as BookmarkEnvironment)}>
            {ENVIRONMENT_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="field-label">
          项目（可选）
          <input aria-label="项目名称" disabled={busy} value={project} onChange={(event) => setProject(event.target.value)} placeholder="留空表示通用" />
        </label>
      </div>
      <label className="replacement-toggle">
        <input type="checkbox" disabled={busy} checked={noAutoMove} onChange={(event) => setNoAutoMove(event.target.checked)} />
        不要自动移动这条书签
      </label>
      <div className="button-row">
        <button type="button" className="primary-button" disabled={busy} onClick={() => void onSave({ purpose, environment, project: project.trim(), noAutoMove }, 'item')}>
          仅修正此条
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void onSave({ purpose, environment, project: project.trim(), noAutoMove }, 'host')}>
          按域名保存规则
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void onSave({ purpose, environment, project: project.trim(), noAutoMove }, 'pathPrefix')}>
          按路径前缀保存规则
        </button>
        <button type="button" className="text-button" disabled={busy} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}
