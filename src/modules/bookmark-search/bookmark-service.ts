export interface BookmarkEntry {
  id: string;
  title: string;
  url: string;
  folderPath: string;
}

const FOLDER_SEPARATOR = ' / ';

export const flattenBookmarkTree = (
  nodes: chrome.bookmarks.BookmarkTreeNode[],
  parentPath = '',
): BookmarkEntry[] =>
  nodes.flatMap((node) => {
    if (node.url) {
      return [{ id: node.id, title: node.title || node.url, url: node.url, folderPath: parentPath }];
    }
    const path = parentPath ? `${parentPath}${FOLDER_SEPARATOR}${node.title}` : node.title;
    return flattenBookmarkTree(node.children ?? [], path);
  });

/**
 * 空格分词 AND 匹配：每个词都需命中 title / url / folderPath 至少一处。
 * 打分：标题前缀 5 分、标题包含 3 分、URL 与文件夹各 1 分；同分标题短者优先。
 */
export const searchBookmarks = (entries: BookmarkEntry[], query: string, limit = 50): BookmarkEntry[] => {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const results: { entry: BookmarkEntry; score: number }[] = [];
  for (const entry of entries) {
    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      let tokenScore = 0;
      const title = entry.title.toLocaleLowerCase();
      if (title.startsWith(token)) tokenScore += 5;
      else if (title.includes(token)) tokenScore += 3;
      if (entry.url.toLocaleLowerCase().includes(token)) tokenScore += 1;
      if (entry.folderPath.toLocaleLowerCase().includes(token)) tokenScore += 1;
      if (tokenScore === 0) {
        matchedAll = false;
        break;
      }
      score += tokenScore;
    }
    if (matchedAll) results.push({ entry, score });
  }
  return results
    .sort((left, right) => right.score - left.score || left.entry.title.length - right.entry.title.length)
    .slice(0, limit)
    .map(({ entry }) => entry);
};

export type BookmarkChangeListener = () => void;

export interface BookmarkStore {
  loadBookmarks(): Promise<BookmarkEntry[]>;
  watchBookmarkChanges(listener: BookmarkChangeListener): () => void;
  dispose(): void;
}

/**
 * 书签读取与监听按页面实例隔离：缓存与事件版本号不放在模块级，
 * 多个面板实例互不影响，测试也可以各自创建独立实例。
 */
export const createBookmarkService = (): BookmarkStore => {
  let cache: BookmarkEntry[] | null = null;
  /** 每次书签事件递增；用于识别 getTree() 期间发生变化的过期响应。 */
  let treeVersion = 0;
  let invalidationAttached = false;
  const subscriptions = new Set<BookmarkChangeListener>();

  const invalidateCache = (): void => {
    cache = null;
    treeVersion += 1;
  };

  /** 事件监听只挂一次：即使没有页面订阅，也要保证缓存不会返回过期数据。 */
  const attachInvalidation = (): void => {
    if (invalidationAttached) return;
    invalidationAttached = true;
    chrome.bookmarks.onCreated.addListener(invalidateCache);
    chrome.bookmarks.onRemoved.addListener(invalidateCache);
    chrome.bookmarks.onChanged.addListener(invalidateCache);
    chrome.bookmarks.onMoved.addListener(invalidateCache);
  };

  /**
   * 读取全部书签。事件到达使版本递增后，较早启动的 getTree() 即使较晚完成，
   * 也不能写回缓存；版本仍在变化时返回最新一次读取且不缓存。
   */
  const loadBookmarks = async (): Promise<BookmarkEntry[]> => {
    attachInvalidation();
    if (cache) return cache;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const requestedVersion = treeVersion;
      const entries = flattenBookmarkTree(await chrome.bookmarks.getTree());
      if (requestedVersion === treeVersion) {
        cache = entries;
        return entries;
      }
    }
    throw new Error('书签持续变化，暂时无法取得稳定结果，请重试。');
  };

  /**
   * 订阅式监听：书签创建、删除、改名、改网址、移动时通知订阅方（当前书签页）
   * 重新加载；缓存失效由 attachInvalidation 统一处理。返回解除监听的清理函数。
   */
  const watchBookmarkChanges = (listener: BookmarkChangeListener): (() => void) => {
    subscriptions.add(listener);
    chrome.bookmarks.onCreated.addListener(listener);
    chrome.bookmarks.onRemoved.addListener(listener);
    chrome.bookmarks.onChanged.addListener(listener);
    chrome.bookmarks.onMoved.addListener(listener);
    return () => {
      subscriptions.delete(listener);
      chrome.bookmarks.onCreated.removeListener(listener);
      chrome.bookmarks.onRemoved.removeListener(listener);
      chrome.bookmarks.onChanged.removeListener(listener);
      chrome.bookmarks.onMoved.removeListener(listener);
    };
  };

  const dispose = (): void => {
    for (const listener of subscriptions) {
      chrome.bookmarks.onCreated.removeListener(listener);
      chrome.bookmarks.onRemoved.removeListener(listener);
      chrome.bookmarks.onChanged.removeListener(listener);
      chrome.bookmarks.onMoved.removeListener(listener);
    }
    subscriptions.clear();
    if (invalidationAttached) {
      chrome.bookmarks.onCreated.removeListener(invalidateCache);
      chrome.bookmarks.onRemoved.removeListener(invalidateCache);
      chrome.bookmarks.onChanged.removeListener(invalidateCache);
      chrome.bookmarks.onMoved.removeListener(invalidateCache);
      invalidationAttached = false;
    }
    cache = null;
    treeVersion += 1;
  };

  return { loadBookmarks, watchBookmarkChanges, dispose };
};
