/**
 * 书签树快照：保留父 ID、顺序、节点类型与可修改性，供分类与整理计划使用。
 * 快照只是当次扫描结果，不写入扩展存储；存储里只保存计划与前置条件。
 */

export type BookmarkFolderType = 'bookmarks-bar' | 'other' | 'mobile' | 'managed';

export interface BookmarkSnapshotNode {
  id: string;
  parentId: string | null;
  index: number;
  title: string;
  /** 文件夹节点为 null。 */
  url: string | null;
  folderType: BookmarkFolderType | null;
  /** 节点自身或任一祖先不可修改时为 false。 */
  modifiable: boolean;
  dateAdded?: number;
  dateLastUsed?: number;
  /** 从最顶层根到本节点的显示路径，如「书签栏 / 开发」。 */
  path: string;
  /** 从书签栏根（不含）到父文件夹的目标式路径，段间以「/」分隔；书签栏直属子级为 ''。 */
  relativeFolderPath: string | null;
  /** 从书签栏根（含）到本节点自身的目标式路径；书签栏根为 ''，栏外节点为 null。 */
  selfRelativePath: string | null;
  /** 本节点所属书签栏根的 ID；不在任何书签栏子树内时为 null。 */
  barRootId: string | null;
}

export interface BookmarkSnapshot {
  nodes: Record<string, BookmarkSnapshotNode>;
  rootIds: string[];
  /** 所有 folderType 为 bookmarks-bar 的根；不假设只存在一个。 */
  barRootIds: string[];
}

/** Chrome 未提供 folderType 时的兜底名称；正常情况下以 folderType 为准。 */
const BAR_ROOT_TITLE_FALLBACKS = new Set(['书签栏', '书签工具栏', 'bookmarks bar', 'bookmarks']);

const FOLDER_SEPARATOR = ' / ';

export const TARGET_SEPARATOR = '/';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeFolderType = (value: unknown): BookmarkFolderType | null => {
  if (value === 'bookmarks-bar') return 'bookmarks-bar';
  return value === 'other' || value === 'mobile' || value === 'managed' ? value : null;
};

export const isBookmarkNode = (node: BookmarkSnapshotNode): boolean => node.url !== null;

export const urlFingerprint = (url: string): string => {
  const trimmed = url.trim();
  try {
    // URL 解析器已经规范化 scheme/host；path、query 可能区分大小写。
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
};

/** 校验并切分目标路径；段数、段长受限，拒绝空段与控制字符。 */
export const splitTargetPath = (path: string): string[] | null => {
  const segments = path.split(TARGET_SEPARATOR).map((segment) => segment.trim());
  if (segments.length === 0 || segments.length > 8) return null;
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > 60) return null;
    // 目标路径会用于 chrome.bookmarks.create 的标题，拒绝控制字符。
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(segment)) return null;
    if (segment === '.' || segment === '..') return null;
  }
  return segments;
};

export const joinTargetPath = (segments: string[]): string => segments.join(TARGET_SEPARATOR);

/**
 * 从 chrome.bookmarks.getTree() 结果构建快照。
 * 通过 folderType 识别书签栏根，不硬编码根 ID，也不假设只存在一个书签栏根；
 * 整棵树都没有 folderType 时（测试环境或极旧版本）退回按顶层文件夹标题识别。
 */
export const createBookmarkSnapshot = (tree: chrome.bookmarks.BookmarkTreeNode[]): BookmarkSnapshot => {
  const nodes: Record<string, BookmarkSnapshotNode> = {};
  const rootIds: string[] = [];
  let sawFolderType = false;

  const walk = (
    node: unknown,
    parentId: string | null,
    index: number,
    parentPath: string,
    parentModifiable: boolean,
    inheritedBarRootId: string | null,
    folderTypeOverride: BookmarkFolderType | null,
  ): void => {
    if (!isRecord(node) || typeof node.id !== 'string') return;
    const ownFolderType = normalizeFolderType(node.folderType) ?? folderTypeOverride;
    if (normalizeFolderType(node.folderType)) sawFolderType = true;
    const unmodifiable = typeof node.unmodifiable === 'string' && node.unmodifiable.length > 0;
    const modifiable = parentModifiable && !unmodifiable;
    const title = typeof node.title === 'string' ? node.title : '';
    const url = typeof node.url === 'string' ? node.url : null;
    const path = parentPath
      ? `${parentPath}${FOLDER_SEPARATOR}${title || url || node.id}`
      : (title || url || node.id);

    nodes[node.id] = {
      id: node.id,
      parentId,
      index,
      title,
      url,
      folderType: ownFolderType,
      modifiable,
      ...(typeof node.dateAdded === 'number' ? { dateAdded: node.dateAdded } : {}),
      ...(typeof node.dateLastUsed === 'number' ? { dateLastUsed: node.dateLastUsed } : {}),
      path,
      relativeFolderPath: null,
      selfRelativePath: null,
      barRootId: inheritedBarRootId,
    };

    // 顶层根先收集；书签栏根在遍历子级时确定。
    if (parentId === null) rootIds.push(node.id);

    const children = Array.isArray(node.children) ? node.children : [];
    let childBarRootId = inheritedBarRootId;
    if (inheritedBarRootId === null && ownFolderType === 'bookmarks-bar') childBarRootId = node.id;

    let childIndex = 0;
    for (const child of children) {
      walk(child, node.id, childIndex, path, modifiable, childBarRootId, null);
      childIndex += 1;
    }
  };

  for (const root of tree) walk(root, null, 0, '', true, null, null);

  let barRootIds = Object.values(nodes)
    .filter((node) => node.folderType === 'bookmarks-bar')
    .map((node) => node.id);
  if (!sawFolderType) {
    // 兜底：整棵树没有 folderType 时按顶层文件夹标题识别书签栏根。
    barRootIds = rootIds.flatMap((rootId) =>
      childrenOfIds(nodes, rootId)
        .filter((child) => BAR_ROOT_TITLE_FALLBACKS.has(child.title.trim().toLocaleLowerCase()))
        .map((child) => child.id),
    );
    for (const barRootId of barRootIds) {
      const node = nodes[barRootId];
      if (node) node.folderType = 'bookmarks-bar';
    }
  }

  // 第二遍：计算每个节点的 relativeFolderPath 与 barRootId。
  // relativeFolderPath 语义：从书签栏根（不含）到父文件夹的路径；
  // 书签栏直属子级为 ''，书签栏根本身恒为 null。
  const computeRelative = (nodeId: string, parentChain: string): void => {
    const node = nodes[nodeId];
    if (!node) return;
    const isBarRoot = barRootIds.includes(nodeId);
    if (isBarRoot) node.barRootId = nodeId;
    const inBar = node.barRootId !== null;
    node.relativeFolderPath = !inBar || isBarRoot ? null : parentChain;
    // 自身路径：书签栏根为 ''；栏内文件夹含自身标题；栏内书签沿用父链；栏外一律 null。
    node.selfRelativePath = !inBar
      ? null
      : isBarRoot
        ? ''
        : node.url === null
          ? parentChain === '' ? node.title : `${parentChain}${TARGET_SEPARATOR}${node.title}`
          : parentChain;
    const childChain = !inBar || isBarRoot
      ? ''
      : parentChain === '' ? node.title : `${parentChain}${TARGET_SEPARATOR}${node.title}`;
    for (const child of childrenOfIds(nodes, nodeId)) {
      computeRelative(child.id, childChain);
    }
  };
  for (const rootId of rootIds) computeRelative(rootId, '');

  return { nodes, rootIds, barRootIds };
};

const childrenOfIds = (nodes: Record<string, BookmarkSnapshotNode>, parentId: string): BookmarkSnapshotNode[] =>
  Object.values(nodes)
    .filter((node) => node.parentId === parentId)
    .sort((left, right) => left.index - right.index);

export const childrenOf = (snapshot: BookmarkSnapshot, parentId: string): BookmarkSnapshotNode[] =>
  childrenOfIds(snapshot.nodes, parentId);

/** 深度优先列出子树内所有节点（不含自身）。 */
export const listSubtree = (snapshot: BookmarkSnapshot, rootId: string): BookmarkSnapshotNode[] => {
  const result: BookmarkSnapshotNode[] = [];
  const stack = childrenOf(snapshot, rootId).reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node);
    for (const child of childrenOf(snapshot, node.id).reverse()) stack.push(child);
  }
  return result;
};

export const listBookmarksInSubtree = (snapshot: BookmarkSnapshot, rootId: string): BookmarkSnapshotNode[] =>
  listSubtree(snapshot, rootId).filter(isBookmarkNode);

export const listFoldersInSubtree = (snapshot: BookmarkSnapshot, rootId: string): BookmarkSnapshotNode[] =>
  listSubtree(snapshot, rootId).filter((node) => !isBookmarkNode(node));

export const getNode = (snapshot: BookmarkSnapshot, id: string): BookmarkSnapshotNode | null =>
  snapshot.nodes[id] ?? null;
