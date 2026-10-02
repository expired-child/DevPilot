/**
 * 整理器的持久化状态：用户规则、单条覆盖、设置、活动日志与批次操作日志。
 * 使用独立的版本化键 bookmarkOrganizer:v1，不与表单剪贴板共用任何数据键。
 * 撤销依赖这里的批次日志，因此只能存 chrome.storage.local（session 会在重启后清空）。
 */

import type { BookmarkEnvironment, BookmarkPurpose } from './bookmark-classifier';
import type { BookmarkOverride, UserRule } from './bookmark-rules';

export const ORGANIZER_STORAGE_KEY = 'bookmarkOrganizer:v1';

export const ORGANIZER_STATE_VERSION = 1;

export interface OrganizerSettings {
  /** 显式开启后才允许对新书签执行确定性自动归档。 */
  autoArchiveEnabled: boolean;
  /** 开启后允许调用 DeepSeek 为新书签选择目录；旧数据默认关闭。 */
  aiAutoPlaceEnabled?: boolean;
}

export type BatchItemStatus = 'pending' | 'applied' | 'skipped' | 'failed';

export interface BatchItemLog {
  bookmarkId: string;
  urlFingerprint: string;
  title: string;
  url: string;
  originalParentId: string;
  /** 执行时从真实树记录，用于撤销恢复原顺序。 */
  originalIndex: number;
  originalTitle: string;
  targetPath: string;
  targetFolderId?: string;
  status: BatchItemStatus;
  reason?: string;
}

export interface BatchArchiveLog {
  mode?: 'delete';
  deletionStarted?: boolean;
  restoredFolderId?: string;
  folderId: string;
  title: string;
  originalParentId: string;
  originalIndex: number;
  archiveFolderId?: string;
  status: BatchItemStatus;
  reason?: string;
}

export type OrganizeBatchStatus = 'running' | 'completed' | 'undone';

export interface OrganizeBatch {
  cleanupEmptyFolders?: boolean;
  id: string;
  startedAt: number;
  finishedAt?: number;
  undoneAt?: number;
  status: OrganizeBatchStatus;
  /** completed 批次的结果：全部成功 / 部分成功 / 全部失败。 */
  outcome?: 'applied' | 'partial' | 'failed';
  items: BatchItemLog[];
  /** 本批次新建的目标文件夹，撤销时仅在仍为空时删除。 */
  createdFolders: Array<{ id: string; path: string }>;
  /** 已执行的归档记录；撤销时先还原这些文件夹。 */
  archivedFolders: BatchArchiveLog[];
  /** 撤销时发现的冲突（外部改动），逐条列出且不覆盖。 */
  undoReport: Array<{ kind: 'item' | 'archive' | 'folder'; id: string; reason: string }>;
  plannedArchives: Array<{ folderId: string; title: string; path: string; originalParentId: string; originalIndex: number }>;
}

export type ActivityKind = 'auto-place-progress' | 'auto-move' | 'auto-place-skip' | 'manual-save' | 'apply' | 'undo';

export interface ActivityEntry {
  kind: ActivityKind;
  /** 手动保存的节点身份：后台恢复时仍保留用户指定的目录。 */
  bookmarkId?: string;
  at: number;
  title: string;
  detail: string;
}

export interface OrganizerState {
  version: typeof ORGANIZER_STATE_VERSION;
  /** 规则或单条覆盖变化时递增，用于拒绝跨窗口的过期预览和写入。 */
  classificationRevision: number;
  rules: UserRule[];
  overrides: Record<string, BookmarkOverride>;
  settings: OrganizerSettings;
  batches: OrganizeBatch[];
  activity: ActivityEntry[];
}

export const defaultOrganizerState = (): OrganizerState => ({
  version: ORGANIZER_STATE_VERSION,
  classificationRevision: 0,
  rules: [],
  overrides: {},
  settings: { autoArchiveEnabled: false, aiAutoPlaceEnabled: false },
  batches: [],
  activity: [],
});

const MAX_COMPLETED_BATCHES = 10;
const MAX_ACTIVITY = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 读取时逐字段兜底：缺字段、坏类型都回落默认值，不让旧数据毁掉整个状态。 */
export const normalizeOrganizerState = (stored: unknown): OrganizerState => {
  const defaults = defaultOrganizerState();
  if (!isRecord(stored)) return defaults;
  const settings = isRecord(stored.settings) ? stored.settings : {};
  return {
    version: ORGANIZER_STATE_VERSION,
    classificationRevision: typeof stored.classificationRevision === 'number' &&
      Number.isSafeInteger(stored.classificationRevision) && stored.classificationRevision >= 0
      ? stored.classificationRevision : 0,
    rules: Array.isArray(stored.rules) ? stored.rules.filter(isRecord).map((rule) =>
      rule.kind === 'pathPrefix' && !rule.host
        ? { ...rule, enabled: false } as unknown as UserRule
        : rule as unknown as UserRule) : defaults.rules,
    overrides: isRecord(stored.overrides) ? (stored.overrides as Record<string, BookmarkOverride>) : defaults.overrides,
    settings: {
      autoArchiveEnabled: settings.autoArchiveEnabled === true,
      aiAutoPlaceEnabled: settings.aiAutoPlaceEnabled === true,
    },
    batches: Array.isArray(stored.batches) ? (stored.batches as OrganizeBatch[]) : defaults.batches,
    activity: Array.isArray(stored.activity) ? (stored.activity as ActivityEntry[]) : defaults.activity,
  };
};

/** 保留所有未完成批次与最近 10 个已完成/已撤销批次；超出只移除最旧的已结束批次。 */
export const pruneBatches = (batches: OrganizeBatch[]): OrganizeBatch[] => {
  const unfinished = batches.filter((batch) => batch.status === 'running');
  const finished = batches
    .filter((batch) => batch.status !== 'running')
    .sort((left, right) => (right.undoneAt ?? right.finishedAt ?? 0) - (left.undoneAt ?? left.finishedAt ?? 0));
  return [...unfinished, ...finished.slice(0, MAX_COMPLETED_BATCHES)];
};

export const appendActivity = (activity: ActivityEntry[], entry: ActivityEntry): ActivityEntry[] =>
  [entry, ...activity].slice(0, MAX_ACTIVITY);

export const unfinishedBatch = (state: OrganizerState): OrganizeBatch | null =>
  state.batches.find((batch) => batch.status === 'running') ?? null;

export const recordActivity = (state: OrganizerState, entry: ActivityEntry): OrganizerState => ({
  ...state,
  activity: appendActivity(state.activity, entry),
});

export interface OrganizerRepository {
  load(): Promise<OrganizerState>;
  save(state: OrganizerState): Promise<void>;
}

export class ChromeOrganizerRepository implements OrganizerRepository {
  async load(): Promise<OrganizerState> {
    const stored = (await chrome.storage.local.get(ORGANIZER_STORAGE_KEY))[ORGANIZER_STORAGE_KEY];
    return normalizeOrganizerState(stored);
  }

  async save(state: OrganizerState): Promise<void> {
    await chrome.storage.local.set({ [ORGANIZER_STORAGE_KEY]: { ...state, batches: pruneBatches(state.batches) } });
  }
}

/** 生成规则/批次 ID：无 crypto.randomUUID 的环境回落时间戳。 */
export const createOrganizerId = (prefix: string): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export type { BookmarkEnvironment, BookmarkPurpose };
