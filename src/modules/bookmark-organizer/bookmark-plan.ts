/**
 * 整理预览：把分类结果转成可编辑的批量计划。
 * 只读计算，不写书签；计划项自带前置条件（原父 ID/顺序/标题/URL 指纹），
 * 应用前由后台重新核对。
 */

import { classifyBookmark, suggestedTargetPath, type Classification } from './bookmark-classifier';
import type { BookmarkOverride, UserRule } from './bookmark-rules';
import {
  createBookmarkSnapshot,
  getNode,
  isBookmarkNode,
  listBookmarksInSubtree,
  listFoldersInSubtree,
  childrenOf,
  urlFingerprint,
  type BookmarkSnapshot,
  type BookmarkSnapshotNode,
} from './bookmark-tree';

export type PlanItemStatus = 'move' | 'keep' | 'review' | 'conflict' | 'pinned';

export interface PlanRowState {
  badge: string;
  badgeStatus: PlanItemStatus;
  targetText: string;
  hint: string | null;
  selectable: boolean;
  canAdopt: boolean;
  showSelectionTag: boolean;
  stateText: string;
}

/** 去掉路径首尾空白及末尾斜杠，统一比较用户手填目标与当前目录。 */
export const normalizePlanPath = (path: string | null | undefined): string =>
  (path ?? '').trim().replace(/\/+$/, '');

/** 只有存在与当前目录不同的目标，且没有被固定，才是一次可以提交给后台的移动。 */
export const canApplyPlanItem = (
  item: Pick<OrganizePlanItem, 'status' | 'targetPath' | 'fromRelativePath'>,
): boolean => {
  if (item.status === 'pinned') return false;
  const targetPath = normalizePlanPath(item.targetPath);
  return Boolean(targetPath) && targetPath !== normalizePlanPath(item.fromRelativePath);
};

/** 由计划项派生行内唯一可见状态，避免 verdict、status、selected 各显示一套互相矛盾的文案。 */
export const describePlanRow = (item: OrganizePlanItem): PlanRowState => {
  const targetPath = normalizePlanPath(item.targetPath);
  const hasTarget = Boolean(targetPath);
  const actionable = canApplyPlanItem(item);
  const sameFolder = hasTarget && targetPath === normalizePlanPath(item.fromRelativePath);
  const pinned = item.status === 'pinned';
  const needsTarget = !actionable && (item.status === 'review' || item.status === 'conflict');

  let badge = VERDICT_LABELS[item.classification.verdict];
  if (pinned) badge = '已固定';
  else if (item.status === 'review') badge = actionable ? '有建议·待采用' : sameFolder ? '目标在原位' : '无建议·保持原位';
  else if (item.status === 'conflict') badge = actionable ? '冲突·待采用' : sameFolder ? '目标在原位' : '冲突·待指定目录';
  else if (!hasTarget) badge = '无建议·保持原位';
  else if (sameFolder) badge = '目标在原位';

  const targetText = actionable
    ? `${item.fromPath || '书签栏'} → ${targetPath}`
    : pinned
      ? `${item.fromPath || '书签栏'} → 保持原位（已固定）`
      : sameFolder
        ? `${item.fromPath || '书签栏'} → 保持原位（目标与当前位置相同）`
        : `${item.fromPath || '书签栏'} → 保持原位`;
  const hint = needsTarget ? '展开本条，填写一个与当前位置不同的目标文件夹后，才能选入批次。' : null;
  return {
    badge,
    badgeStatus: item.status,
    targetText,
    hint,
    selectable: actionable,
    // 「采用目标」只服务于待确认/冲突项；已默认选中的 move 项不需要重复按钮。
    canAdopt: actionable && !item.selected && (item.status === 'review' || item.status === 'conflict'),
    // 默认选中的 move 项用复选框表示批次；额外标记只提示用户亲手采用的待确认项。
    showSelectionTag: actionable && item.selected && (item.status === 'review' || item.status === 'conflict'),
    stateText: `${badge}；${actionable ? item.selected ? '已选入批次' : '未选入批次' : '不可选入批次'}`,
  };
};

const VERDICT_LABELS: Record<string, string> = { certain: '确定', review: '待确认', conflict: '冲突' };

export interface OrganizePlanItem {
  bookmarkId: string;
  title: string;
  url: string;
  urlFingerprint: string;
  host: string;
  /** 显示用完整路径，如「书签栏 / 开发」。 */
  fromPath: string;
  /** 与书签栏根比较用的相对路径，如「开发」。 */
  fromRelativePath: string;
  suggestedPath: string | null;
  /** 生效目标：用户显式指定的 targetPath 优先于分类建议。 */
  targetPath: string | null;
  classification: Classification;
  status: PlanItemStatus;
  /** 计划生成时的前置条件；应用时后台逐条核对。 */
  originalParentId: string;
  originalIndex: number;
  originalTitle: string;
  /** move 默认选中；review/conflict 必须由用户点选；keep/pinned 不可选。 */
  selected: boolean;
}

export interface ArchiveCandidate {
  folderId: string;
  title: string;
  path: string;
  originalParentId: string;
  originalIndex: number;
}

export interface OrganizePreview {
  generatedAt: number;
  scopeFolderId: string | null;
  items: OrganizePlanItem[];
  archiveCandidates: ArchiveCandidate[];
  counts: { move: number; keep: number; review: number; conflict: number; pinned: number };
  /** 计划生成时的树摘要，用于展示与排错。 */
  summary: { bookmarkCount: number; folderCount: number };
}

export interface BuildPreviewOptions {
  rules: UserRule[];
  overrides: Record<string, BookmarkOverride>;
  scopeFolderId?: string | null;
}

/** “收起空旧目录”的目标存档位置；该前缀下的文件夹永不被归档。 */
export const ARCHIVE_ROOT_PATH = '整理存档/空目录';

const protectedPrefixesFor = (targetPaths: string[]): Set<string> => {
  const prefixes = new Set<string>([ARCHIVE_ROOT_PATH, ARCHIVE_ROOT_PATH.split('/')[0]]);
  for (const path of targetPaths) {
    const segments = path.split('/');
    for (let i = 1; i <= segments.length; i += 1) {
      prefixes.add(segments.slice(0, i).join('/'));
    }
  }
  return prefixes;
};

const folderNamesFor = (snapshot: BookmarkSnapshot, node: BookmarkSnapshotNode): string[] => {
  const names: string[] = [];
  let current = node.parentId ? getNode(snapshot, node.parentId) : null;
  while (current && current.barRootId !== current.id && current.parentId !== null) {
    names.unshift(current.title);
    current = current.parentId ? getNode(snapshot, current.parentId) : null;
  }
  return names;
};

const statusOf = (classification: Classification, fromRelative: string, targetPath: string | null): PlanItemStatus => {
  if (classification.noAutoMove) return 'pinned';
  if (classification.verdict === 'conflict') return 'conflict';
  if (classification.verdict === 'review') return 'review';
  if (targetPath === null || targetPath === fromRelative) return 'keep';
  return 'move';
};

/**
 * 构建整理预览。scopeFolderId 为空表示整理整个书签栏（所有书签栏根）；
 * 指定文件夹时只处理该子树，且该文件夹必须位于某个书签栏内。
 */
export const buildOrganizePreview = (
  tree: chrome.bookmarks.BookmarkTreeNode[],
  options: BuildPreviewOptions,
): OrganizePreview => {
  const snapshot = createBookmarkSnapshot(tree);
  const generatedAt = Date.now();
  const empty: OrganizePreview = {
    generatedAt, scopeFolderId: options.scopeFolderId ?? null,
    items: [], archiveCandidates: [],
    counts: { move: 0, keep: 0, review: 0, conflict: 0, pinned: 0 },
    summary: { bookmarkCount: 0, folderCount: 0 },
  };

  let scopeRootIds: string[];
  if (options.scopeFolderId) {
    const scopeNode = getNode(snapshot, options.scopeFolderId);
    if (!scopeNode || isBookmarkNode(scopeNode) || scopeNode.barRootId === null) {
      throw new Error('所选文件夹不在书签栏内，无法作为整理范围。');
    }
    scopeRootIds = [scopeNode.id];
  } else {
    scopeRootIds = snapshot.barRootIds;
  }
  if (scopeRootIds.length === 0) return empty;

  const items: OrganizePlanItem[] = [];
  let bookmarkCount = 0;
  let folderCount = 0;

  for (const scopeRootId of scopeRootIds) {
    const folders = listFoldersInSubtree(snapshot, scopeRootId);
    folderCount += folders.length + 1;
    const bookmarks = listBookmarksInSubtree(snapshot, scopeRootId);
    bookmarkCount += bookmarks.length;

    for (const node of bookmarks) {
      // 受管理或位于不可修改链上的节点不生成任何移动操作，也不进入预览。
      if (!node.modifiable) continue;
      const fingerprint = urlFingerprint(node.url!);
      const override = options.overrides[node.id];
      const validOverride = override && override.urlFingerprint === fingerprint ? override : undefined;
      const classification = classifyBookmark(
        { title: node.title, url: node.url!, folderNames: folderNamesFor(snapshot, node) },
        options.rules,
        validOverride,
      );
      const suggested = suggestedTargetPath(classification);
      const targetPath = validOverride?.targetPath ?? suggested;
      const fromRelative = node.relativeFolderPath ?? '';
      const status = statusOf(classification, fromRelative, targetPath);
      items.push({
        bookmarkId: node.id,
        title: node.title || node.url!,
        url: node.url!,
        urlFingerprint: fingerprint,
        host: safeHost(node.url!),
        fromPath: node.path,
        fromRelativePath: fromRelative,
        suggestedPath: suggested,
        targetPath,
        classification,
        status,
        originalParentId: node.parentId!,
        originalIndex: node.index,
        originalTitle: node.title,
        selected: status === 'move',
      });
    }
  }

  const moveTargets = items.filter((item) => item.status === 'move' && item.targetPath)
    .map((item) => item.targetPath!);
  const protectedPrefixes = protectedPrefixesFor(moveTargets);

  // 自底向上找出搬迁后会变空的普通文件夹；只列最外层，且绝不包含目标路径的祖先。
  const candidateIds = new Set<string>();
  const isEmptied = (folder: BookmarkSnapshotNode): boolean => {
    if (!folder.modifiable || folder.barRootId === null) return false;
    if (folder.barRootId === folder.id) return false; // 书签栏根本身不参与归档
    // 归档判断用文件夹自身的相对路径：目标路径的祖先永不归档。
    const selfPath = folder.selfRelativePath;
    if (selfPath === null || protectedPrefixes.has(selfPath)) return false;
    const children = childrenOf(snapshot, folder.id);
    if (children.length === 0) return false;
    return children.every((child) =>
      isBookmarkNode(child)
        ? items.some((item) => item.bookmarkId === child.id && item.status === 'move')
        : candidateIds.has(child.id),
    );
  };
  for (const scopeRootId of scopeRootIds) {
    const folders = listFoldersInSubtree(snapshot, scopeRootId);
    for (const folder of [...folders].reverse()) {
      if (isEmptied(folder)) candidateIds.add(folder.id);
    }
  }
  const archiveCandidates: ArchiveCandidate[] = [...candidateIds]
    .map((folderId) => getNode(snapshot, folderId)!)
    .filter((folder) => {
      const parent = folder.parentId ? getNode(snapshot, folder.parentId) : null;
      // 只列最外层：父文件夹本身也会变空时，父文件夹才是归档对象。
      return !parent || !candidateIds.has(parent.id);
    })
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((folder) => ({
      folderId: folder.id,
      title: folder.title,
      path: folder.path,
      originalParentId: folder.parentId!,
      originalIndex: folder.index,
    }));

  const counts = { move: 0, keep: 0, review: 0, conflict: 0, pinned: 0 };
  for (const item of items) counts[item.status] += 1;

  return {
    generatedAt,
    scopeFolderId: options.scopeFolderId ?? null,
    items,
    archiveCandidates,
    counts,
    summary: { bookmarkCount, folderCount },
  };
};

const safeHost = (url: string): string => {
  try {
    return new URL(url.trim()).hostname;
  } catch {
    return '';
  }
};

/** 根据实际勾选项计算范围内空目录（含原有空目录），自底向上列出，范围根和目标路径均保留。 */
export const emptyFolderCandidates = (
  snapshot: BookmarkSnapshot,
  scopeFolderId: string | null,
  moves: Array<{ bookmarkId: string; targetPath: string }>,
): ArchiveCandidate[] => {
  const roots = scopeFolderId ? [scopeFolderId] : snapshot.barRootIds;
  if (roots.some((id) => {
    const node = getNode(snapshot, id);
    return !node || isBookmarkNode(node) || node.barRootId === null;
  })) throw new Error('所选文件夹不在书签栏内，无法作为整理范围。');
  const protectedPaths = new Set<string>();
  for (const move of moves) {
    const segments = move.targetPath.split('/');
    for (let i = 1; i <= segments.length; i += 1) protectedPaths.add(segments.slice(0, i).join('/'));
  }
  const movingIds = new Set(moves.filter((move) => getNode(snapshot, move.bookmarkId)?.relativeFolderPath !== move.targetPath)
    .map((move) => move.bookmarkId));
  const emptiedIds = new Set<string>();
  const result: ArchiveCandidate[] = [];
  for (const root of roots) {
    for (const folder of listFoldersInSubtree(snapshot, root).reverse()) {
      if (!folder.modifiable || folder.folderType !== null || protectedPaths.has(folder.selfRelativePath ?? '')) continue;
      if (!childrenOf(snapshot, folder.id).every((child) => isBookmarkNode(child)
        ? movingIds.has(child.id) : emptiedIds.has(child.id))) continue;
      emptiedIds.add(folder.id);
      result.push({ folderId: folder.id, title: folder.title, path: folder.path,
        originalParentId: folder.parentId!, originalIndex: folder.index });
    }
  }
  return result;
};

/** 按归一化 targetPath 分组可执行的移动项，供预览与执行展示。 */
export const groupPlanItemsByTarget = (
  items: OrganizePlanItem[],
): Array<{ targetPath: string; items: OrganizePlanItem[] }> => {
  const groups = new Map<string, OrganizePlanItem[]>();
  for (const item of items) {
    if (item.status !== 'move' || !canApplyPlanItem(item)) continue;
    const targetPath = normalizePlanPath(item.targetPath);
    const bucket = groups.get(targetPath) ?? [];
    bucket.push(item);
    groups.set(targetPath, bucket);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([targetPath, grouped]) => ({ targetPath, items: grouped }));
};
