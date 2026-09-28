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

let cache: BookmarkEntry[] | null = null;

const invalidateCache = (): void => {
  cache = null;
};

export const loadBookmarks = async (): Promise<BookmarkEntry[]> => {
  if (!cache) {
    cache = flattenBookmarkTree(await chrome.bookmarks.getTree());
  }
  return cache;
};

/** 面板会话期间监听书签变化使缓存失效；返回解除监听的清理函数。 */
export const watchBookmarkChanges = (): (() => void) => {
  chrome.bookmarks.onCreated.addListener(invalidateCache);
  chrome.bookmarks.onRemoved.addListener(invalidateCache);
  chrome.bookmarks.onChanged.addListener(invalidateCache);
  chrome.bookmarks.onMoved.addListener(invalidateCache);
  return () => {
    chrome.bookmarks.onCreated.removeListener(invalidateCache);
    chrome.bookmarks.onRemoved.removeListener(invalidateCache);
    chrome.bookmarks.onChanged.removeListener(invalidateCache);
    chrome.bookmarks.onMoved.removeListener(invalidateCache);
  };
};
