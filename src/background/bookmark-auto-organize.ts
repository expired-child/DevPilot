import { ChromeOrganizerRepository } from '../modules/bookmark-organizer/bookmark-organizer-repository';
import type { BookmarkOrganizeCoordinator } from './bookmark-coordinator';
import { createBookmarkSnapshot } from '../modules/bookmark-organizer/bookmark-tree';

export const NEW_BOOKMARK_SETTLE_MS = 1500;
const QUEUE_KEY = 'bookmarkOrganizer:pending:v2';
const ALARM = 'devpilot-bookmark-placement';
interface Pending { id: string; title: string; url: string; parentId: string; due: number }

/** 仅处理新增到书签栏顶层的收藏；持久化队列供后台休眠后恢复。 */
export const registerBookmarkAutoOrganize = (coordinator: BookmarkOrganizeCoordinator): void => {
  let importing = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const cancelled = new Set<string>();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => {});
    return next;
  };
  const read = async (): Promise<Pending[]> => {
    const value: unknown = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY];
    return Array.isArray(value) ? value.filter((entry): entry is Pending => Boolean(entry) &&
      typeof entry.id === 'string' && typeof entry.url === 'string' && typeof entry.title === 'string' &&
      typeof entry.parentId === 'string' && typeof entry.due === 'number') : [];
  };
  const report = (): void => { console.error('[DevPilot] bookmark-auto-organize:queue-failed'); };
  const drain = async (): Promise<void> => {
    if (running || importing) return;
    running = true;
    try {
      const pending = await serial(read);
      for (const item of pending) {
        if (importing) break;
        if (item.due > Date.now()) continue;
        try {
          const [live] = await chrome.bookmarks.get(item.id);
          if (!cancelled.has(item.id) && live?.title === item.title && live.url === item.url && live.parentId === item.parentId) {
            await coordinator.handleBookmarkCreated(item.id);
          }
        } catch { /* 已被用户删除的节点无需重试。 */ }
        await serial(async () => {
          await chrome.storage.local.set({ [QUEUE_KEY]: (await read()).filter((entry) => entry.id !== item.id || entry.due !== item.due) });
        });
        cancelled.delete(item.id);
      }
    } finally {
      running = false;
      const pending = await serial(read);
      if (pending.length && !importing) {
        clearTimeout(timer);
        timer = setTimeout(() => { void drain().catch(report); }, Math.max(100, Math.min(...pending.map((item) => item.due)) - Date.now()));
      }
    }
  };
  const cancel = (id: string): void => {
    cancelled.add(id);
    coordinator.cancelBookmarkPlacement(id);
    void serial(async () => {
      await chrome.storage.local.set({ [QUEUE_KEY]: (await read()).filter((entry) => entry.id !== id) });
      cancelled.delete(id);
    }).catch(report);
  };
  const schedule = (id: string, node: chrome.bookmarks.BookmarkTreeNode): void => {
    if (importing || !node.url || !node.parentId || !/^https?:/.test(node.url)) return;
    void serial(async () => {
      const state = await new ChromeOrganizerRepository().load();
      if (!state.settings.aiAutoPlaceEnabled && !state.settings.autoArchiveEnabled) return;
      const snapshot = createBookmarkSnapshot(await chrome.bookmarks.getTree());
      if (importing || !snapshot.barRootIds.includes(node.parentId!) || !snapshot.nodes[id]?.modifiable) return;
      const pending = (await read()).filter((item) => item.id !== id);
      pending.push({ id, title: node.title, url: node.url!, parentId: node.parentId!, due: Date.now() + NEW_BOOKMARK_SETTLE_MS });
      await chrome.storage.local.set({ [QUEUE_KEY]: pending });
      clearTimeout(timer);
      timer = setTimeout(() => { void drain().catch(report); }, NEW_BOOKMARK_SETTLE_MS);
    }).catch(report);
  };
  chrome.bookmarks.onCreated.addListener(schedule);
  chrome.bookmarks.onChanged.addListener((id) => {
    // 原生收藏弹窗会在 onCreated 后修改标题；取消旧请求，用最终标题重新排队。
    coordinator.cancelBookmarkPlacement(id);
    void (async () => {
      const tracked = await serial(async () => (await read()).some((item) => item.id === id));
      if (!tracked || importing) return;
      const [node] = await chrome.bookmarks.get(id);
      if (node) schedule(id, node);
    })().catch(report);
  });
  chrome.bookmarks.onMoved.addListener(cancel);
  chrome.bookmarks.onRemoved.addListener(cancel);
  chrome.bookmarks.onChildrenReordered.addListener((_id, info) => info.childIds.forEach(cancel));
  chrome.bookmarks.onImportBegan.addListener(() => {
    importing = true;
    coordinator.setImporting(true);
    void serial(async () => { await chrome.storage.local.remove(QUEUE_KEY); }).catch(report);
  });
  chrome.bookmarks.onImportEnded.addListener(() => { importing = false; coordinator.setImporting(false); });
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void drain().catch(report); });
  void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }).catch(report);
  coordinator.setAutoOrganizeReady(true);
  void drain().catch(report);
};
