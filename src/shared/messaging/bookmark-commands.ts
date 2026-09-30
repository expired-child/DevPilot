/**
 * 书签整理的写命令协议：侧栏等扩展页面唯一的写入口。
 * 每条命令由后台书签协调器串行执行并持久化操作日志；未知类型一律拒绝。
 */

import type { OrganizerSettings, OrganizeBatch } from '../../modules/bookmark-organizer/bookmark-organizer-repository';
import type { BookmarkOverride, UserRule } from '../../modules/bookmark-organizer/bookmark-rules';
import type { BookmarkEnvironment, BookmarkPurpose } from '../../modules/bookmark-organizer/bookmark-classifier';
import type { OrganizePreview } from '../../modules/bookmark-organizer/bookmark-plan';
import type { BookmarkRecommendation } from '../../modules/bookmark-organizer/bookmark-ai';

export const BOOKMARK_COMMANDS = {
  applyBatch: 'APPLY_BOOKMARK_ORGANIZE',
  undoBatch: 'UNDO_BOOKMARK_ORGANIZE',
  retryBatch: 'RETRY_BOOKMARK_ORGANIZE',
  reconcileBatch: 'RECONCILE_BOOKMARK_ORGANIZE',
  saveRules: 'SAVE_BOOKMARK_ORGANIZER_RULES',
  saveOverrides: 'SAVE_BOOKMARK_ORGANIZER_OVERRIDES',
  saveSettings: 'SAVE_BOOKMARK_ORGANIZER_SETTINGS',
  savePageBookmark: 'SAVE_PAGE_BOOKMARK',
  saveAiKey: 'SAVE_BOOKMARK_AI_KEY',
  aiStatus: 'GET_BOOKMARK_AI_STATUS',
  aiPreview: 'GENERATE_BOOKMARK_AI_PREVIEW',
  recommendPage: 'RECOMMEND_PAGE_BOOKMARK',
} as const;

/** 预览中选定的一条移动：后台应用时会重新核对全部前置条件。 */
export interface PlannedMove {
  bookmarkId: string;
  urlFingerprint: string;
  title: string;
  originalParentId: string;
  targetPath: string;
}

export interface PlannedArchive {
  folderId: string;
  title: string;
  path: string;
  originalParentId: string;
  originalIndex: number;
}

export interface OrganizeApplyPlan {
  classificationRevision: number;
  items: PlannedMove[];
  archives: PlannedArchive[];
  cleanupEmptyFolders?: boolean;
  scopeFolderId?: string | null;
}

export type BookmarkCommand =
  | { type: typeof BOOKMARK_COMMANDS.saveAiKey; apiKey: string }
  | { type: typeof BOOKMARK_COMMANDS.aiStatus }
  | { type: typeof BOOKMARK_COMMANDS.aiPreview; scopeFolderId: string | null; expectedRevision: number }
  | { type: typeof BOOKMARK_COMMANDS.recommendPage; title: string; url: string }
  | { type: typeof BOOKMARK_COMMANDS.applyBatch; plan: OrganizeApplyPlan }
  | { type: typeof BOOKMARK_COMMANDS.undoBatch; batchId: string }
  | { type: typeof BOOKMARK_COMMANDS.retryBatch; batchId: string }
  | { type: typeof BOOKMARK_COMMANDS.reconcileBatch; batchId: string }
  | { type: typeof BOOKMARK_COMMANDS.saveRules; rules: UserRule[]; expectedRevision: number }
  | { type: typeof BOOKMARK_COMMANDS.saveOverrides; overrides: Record<string, BookmarkOverride>; expectedRevision: number }
  | { type: typeof BOOKMARK_COMMANDS.saveSettings; settings: Partial<OrganizerSettings> }
  | { type: typeof BOOKMARK_COMMANDS.savePageBookmark; title: string; url: string; targetPath: string };

export type BookmarkCommandResult =
  | { ok: true; batch?: OrganizeBatch; aiConfigured?: boolean; preview?: OrganizePreview; recommendation?: BookmarkRecommendation }
  | { ok: false; error: string };

export const sendBookmarkCommand = async (command: BookmarkCommand): Promise<BookmarkCommandResult> =>
  chrome.runtime.sendMessage(command) as Promise<BookmarkCommandResult>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const validRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const PURPOSES = new Set<BookmarkPurpose>(['business', 'devops', 'monitoring', 'design', 'ai', 'network', 'unknown']);
const ENVIRONMENTS = new Set<BookmarkEnvironment>(['prod', 'pre', 'demo', 'test', 'unknown']);
const RULE_KINDS = new Set<string>(['host', 'pathPrefix', 'titleKeyword', 'folder']);

const isPurpose = (value: unknown): value is BookmarkPurpose => PURPOSES.has(value as BookmarkPurpose);
const isEnvironment = (value: unknown): value is BookmarkEnvironment => ENVIRONMENTS.has(value as BookmarkEnvironment);

const isValidTargetPath = (value: unknown): value is string => {
  if (!nonEmptyString(value)) return false;
  const segments = value.split('/');
  return segments.length <= 8 && segments.every((segment) => {
    const trimmed = segment.trim();
    return trimmed.length > 0 && trimmed.length <= 60 && trimmed !== '.' && trimmed !== '..';
  });
};

const isUserRule = (value: unknown): value is UserRule =>
  isRecord(value) && nonEmptyString(value.id) && RULE_KINDS.has(value.kind as string) &&
  nonEmptyString(value.pattern) && isPurpose(value.purpose) &&
  (value.kind !== 'pathPrefix' || nonEmptyString(value.host) || value.enabled === false) &&
  (value.host === undefined || nonEmptyString(value.host)) &&
  (value.project === undefined || typeof value.project === 'string') &&
  (value.environment === undefined || isEnvironment(value.environment)) &&
  typeof value.enabled === 'boolean' && typeof value.createdAt === 'number';

const isBookmarkOverride = (value: unknown): value is BookmarkOverride =>
  isRecord(value) && nonEmptyString(value.bookmarkId) && nonEmptyString(value.urlFingerprint) &&
  isPurpose(value.purpose) &&
  (value.project === undefined || typeof value.project === 'string') &&
  (value.environment === undefined || isEnvironment(value.environment)) &&
  (value.targetPath === undefined || value.targetPath === null || isValidTargetPath(value.targetPath)) &&
  (value.noAutoMove === undefined || typeof value.noAutoMove === 'boolean') &&
  typeof value.updatedAt === 'number';

const isPlannedMove = (value: unknown): value is PlannedMove =>
  isRecord(value) && nonEmptyString(value.bookmarkId) && nonEmptyString(value.urlFingerprint) &&
  nonEmptyString(value.title) && nonEmptyString(value.originalParentId) && isValidTargetPath(value.targetPath);

const isPlannedArchive = (value: unknown): value is PlannedArchive =>
  isRecord(value) && nonEmptyString(value.folderId) && nonEmptyString(value.title) &&
  nonEmptyString(value.path) && nonEmptyString(value.originalParentId) && typeof value.originalIndex === 'number';

/** 只接受预期命令和完整参数，未知类型一律拒绝。 */
export const isBookmarkCommand = (value: unknown): value is BookmarkCommand => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case BOOKMARK_COMMANDS.recommendPage:
      return nonEmptyString(value.title) && isHttpUrl(value.url);
    case BOOKMARK_COMMANDS.saveAiKey:
      return typeof value.apiKey === 'string' && value.apiKey.length <= 256;
    case BOOKMARK_COMMANDS.aiStatus:
      return true;
    case BOOKMARK_COMMANDS.aiPreview:
      return validRevision(value.expectedRevision) && (value.scopeFolderId === null || nonEmptyString(value.scopeFolderId));
    case BOOKMARK_COMMANDS.applyBatch:
      return isRecord(value.plan) && validRevision(value.plan.classificationRevision) &&
        Array.isArray(value.plan.items) && value.plan.items.every(isPlannedMove) &&
        Array.isArray(value.plan.archives) && value.plan.archives.every(isPlannedArchive) &&
        (value.plan.cleanupEmptyFolders === undefined || typeof value.plan.cleanupEmptyFolders === 'boolean') &&
        (value.plan.scopeFolderId === undefined || value.plan.scopeFolderId === null || nonEmptyString(value.plan.scopeFolderId));
    case BOOKMARK_COMMANDS.undoBatch:
    case BOOKMARK_COMMANDS.retryBatch:
    case BOOKMARK_COMMANDS.reconcileBatch:
      return nonEmptyString(value.batchId);
    case BOOKMARK_COMMANDS.saveRules:
      return validRevision(value.expectedRevision) && Array.isArray(value.rules) && value.rules.every(isUserRule);
    case BOOKMARK_COMMANDS.saveOverrides:
      return validRevision(value.expectedRevision) && isRecord(value.overrides) &&
        Object.values(value.overrides).every(isBookmarkOverride);
    case BOOKMARK_COMMANDS.saveSettings:
      return isRecord(value.settings) && Object.keys(value.settings).length > 0 &&
        Object.entries(value.settings).every(([key, setting]) =>
          ['autoArchiveEnabled', 'aiAutoPlaceEnabled'].includes(key) && typeof setting === 'boolean');
    case BOOKMARK_COMMANDS.savePageBookmark:
      return nonEmptyString(value.title) && isValidTargetPath(value.targetPath) && isHttpUrl(value.url);
    default:
      return false;
  }
};

const isHttpUrl = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};
