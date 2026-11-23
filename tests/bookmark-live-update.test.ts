import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBookmarkService } from '../src/modules/bookmark-search/bookmark-service';
import { BookmarkSearchPage } from '../src/sidepanel/pages/BookmarkSearchPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface BookmarkEvents {
  onCreated: chrome.events.Event<(id: string) => void>;
  onRemoved: chrome.events.Event<(id: string, info: { parentId: string }) => void>;
  onChanged: chrome.events.Event<(id: string, info: { title: string; url?: string }) => void>;
  onMoved: chrome.events.Event<(id: string, info: { parentId: string }) => void>;
}

/** 每个事件通道可捕获监听器，便于测试里手动派发书签事件。 */
const stubBookmarkEvents = (): { events: BookmarkEvents; emit: (channel: keyof BookmarkEvents, ...args: unknown[]) => void; listenerCount: (channel: keyof BookmarkEvents) => number } => {
  const listeners: Partial<Record<keyof BookmarkEvents, Array<(...args: unknown[]) => void>>> = {};
  const channel = (name: keyof BookmarkEvents): chrome.events.Event<never> => ({
    addListener: (listener: never) => { listeners[name]!.push(listener as (...args: unknown[]) => void); },
    removeListener: (listener: never) => {
      listeners[name] = listeners[name]!.filter((entry) => entry !== listener);
    },
    getRules: () => [],
    addRules: async () => [],
    removeRules: async () => {},
    hasListener: () => false,
    hasListeners: () => false,
  });
  const events = {
    onCreated: channel('onCreated'),
    onRemoved: channel('onRemoved'),
    onChanged: channel('onChanged'),
    onMoved: channel('onMoved'),
  } as unknown as BookmarkEvents;
  for (const name of ['onCreated', 'onRemoved', 'onChanged', 'onMoved'] as const) listeners[name] = [];
  return {
    events,
    emit: (name, ...args) => { for (const listener of listeners[name] ?? []) listener(...args); },
    listenerCount: (name) => listeners[name]?.length ?? 0,
  };
};

const leaf = (id: string, title: string, url: string): chrome.bookmarks.BookmarkTreeNode =>
  ({ id, title, url, syncing: false });

beforeEach(() => { vi.resetModules(); });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('bookmark service live reload', () => {
  it('re-reads the tree after a bookmark event instead of serving the stale cache', async () => {
    const { events, emit } = stubBookmarkEvents();
    let tree = [leaf('1', 'GitHub', 'https://github.com')];
    const getTree = vi.fn(async () => tree);
    vi.stubGlobal('chrome', { bookmarks: { getTree, ...events } });
    const service = createBookmarkService();

    expect((await service.loadBookmarks()).map(({ id }) => id)).toEqual(['1']);
    tree = [leaf('1', 'GitHub', 'https://github.com'), leaf('2', 'MDN', 'https://developer.mozilla.org')];
    service.watchBookmarkChanges(() => {});
    emit('onCreated', '2');
    expect((await service.loadBookmarks()).map(({ id }) => id)).toEqual(['1', '2']);
    expect(getTree).toHaveBeenCalledTimes(2);
  });

  it('does not cache a tree read that raced with a bookmark event', async () => {
    const { events, emit } = stubBookmarkEvents();
    let releaseTree!: (value: chrome.bookmarks.BookmarkTreeNode[]) => void;
    const getTree = vi.fn()
      .mockImplementationOnce(() => new Promise<chrome.bookmarks.BookmarkTreeNode[]>((resolve) => { releaseTree = resolve; }))
      .mockResolvedValue([leaf('2', 'MDN', 'https://developer.mozilla.org')]);
    vi.stubGlobal('chrome', { bookmarks: { getTree, ...events } });
    const service = createBookmarkService();

    const pending = service.loadBookmarks();
    emit('onRemoved', '1', { parentId: 'root' });
    releaseTree([leaf('1', 'GitHub', 'https://github.com')]);
    // 读取期间发生了书签事件：第一次读取作废，重读后反映最新状态。
    expect((await pending).map(({ id }) => id)).toEqual(['2']);
    expect(getTree).toHaveBeenCalledTimes(2);
    expect((await service.loadBookmarks()).map(({ id }) => id)).toEqual(['2']);
    expect(getTree).toHaveBeenCalledTimes(2);
  });

  it('notifies subscribers on every change channel and stops after unsubscribe', () => {
    const { events, emit } = stubBookmarkEvents();
    vi.stubGlobal('chrome', { bookmarks: { getTree: vi.fn(async () => []), ...events } });
    const service = createBookmarkService();

    const seen: string[] = [];
    const unwatch = service.watchBookmarkChanges(() => seen.push('x'));
    emit('onChanged', '1', { title: 't' });
    emit('onMoved', '1', { parentId: 'root' });
    unwatch();
    emit('onCreated', '9');
    expect(seen).toEqual(['x', 'x']);
  });

  it('removes cache invalidation listeners when the page is disposed', async () => {
    const { events, listenerCount } = stubBookmarkEvents();
    vi.stubGlobal('chrome', { bookmarks: { getTree: vi.fn(async () => []), ...events } });
    const service = createBookmarkService();
    const unwatch = service.watchBookmarkChanges(() => {});
    await service.loadBookmarks();
    expect(listenerCount('onCreated')).toBe(2);
    unwatch();
    expect(listenerCount('onCreated')).toBe(1);
    service.dispose();
    expect(listenerCount('onCreated')).toBe(0);
    expect(listenerCount('onRemoved')).toBe(0);
  });

  it('reports continuous changes instead of returning an unchecked stale read', async () => {
    const { events, emit } = stubBookmarkEvents();
    let changing = true;
    const getTree = vi.fn(async () => {
      if (changing) emit('onChanged', '1', { title: 'changed' });
      return [leaf('1', 'GitHub', 'https://github.com')];
    });
    vi.stubGlobal('chrome', { bookmarks: { getTree, ...events } });
    const service = createBookmarkService();
    await expect(service.loadBookmarks()).rejects.toThrow('书签持续变化');
    expect(getTree).toHaveBeenCalledTimes(5);
    changing = false;
    expect(await service.loadBookmarks()).toHaveLength(1);
    service.dispose();
  });
});

describe('bookmark panel live update', () => {
  const renderPage = async (getTree: () => Promise<chrome.bookmarks.BookmarkTreeNode[]>, events: BookmarkEvents) => {
    vi.stubGlobal('chrome', {
      bookmarks: { getTree: vi.fn(getTree), ...events },
      windows: { getCurrent: async () => ({ id: 42 }) },
      sidePanel: { close: async () => {} },
      tabs: { create: vi.fn(async () => ({ id: 9, windowId: 42 })) },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(BookmarkSearchPage, { focusToken: 1, onBack: () => {} })); });
    await act(async () => { await wait(20); });
    return { container, root };
  };

  const typeQuery = async (container: HTMLElement, query: string): Promise<void> => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索浏览器书签"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('refreshes open results when bookmarks change while the panel stays open', async () => {
    const { events, emit } = stubBookmarkEvents();
    let tree = [leaf('1', 'GitHub', 'https://github.com')];
    const { container, root } = await renderPage(async () => tree, events);

    await typeQuery(container, 'GitHub');
    expect(container.querySelector('.history-list')!.textContent).toContain('GitHub');

    tree = [];
    await act(async () => { emit('onRemoved', '1', { parentId: 'root' }); });
    await act(async () => { await wait(320); }); // 等过合并窗口
    expect(container.querySelector('.history-list')!.textContent).toContain('没有匹配的书签');
    expect(container.querySelector('.section-count')!.textContent).toBe('0');
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('moves the active option to a valid entry after the selected bookmark is deleted', async () => {
    const { events, emit } = stubBookmarkEvents();
    const tree = [
      leaf('1', 'GitHub', 'https://github.com'),
      leaf('2', 'GitHub Pages', 'https://pages.github.com'),
    ];
    const { container, root } = await renderPage(async () => tree, events);

    await typeQuery(container, 'GitHub');
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[aria-label="搜索浏览器书签"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(container.querySelector('.history-item.active')!.textContent).toContain('GitHub Pages');

    const remaining = [leaf('1', 'GitHub', 'https://github.com')];
    Object.defineProperty(chrome.bookmarks, 'getTree', { value: vi.fn(async () => remaining), configurable: true });
    await act(async () => { emit('onRemoved', '2', { parentId: 'root' }); });
    await act(async () => { await wait(320); });

    // 旧条目已不在结果里：回落到第一项，Enter 打开的是现存书签。
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[aria-label="搜索浏览器书签"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://github.com', active: true });
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('keeps old results visible and offers a retry when a refresh fails', async () => {
    const { events, emit } = stubBookmarkEvents();
    const tree = [leaf('1', 'GitHub', 'https://github.com')];
    const { container, root } = await renderPage(async () => tree, events);
    await typeQuery(container, 'GitHub');

    Object.defineProperty(chrome.bookmarks, 'getTree', {
      value: vi.fn(async () => { throw new Error('书签树读取失败'); }), configurable: true,
    });
    await act(async () => { emit('onCreated', '9'); });
    await act(async () => { await wait(320); });
    expect(container.textContent).toContain('书签更新失败');
    expect(container.querySelector('.history-list')!.textContent).toContain('GitHub'); // 旧结果保留

    Object.defineProperty(chrome.bookmarks, 'getTree', { value: vi.fn(async () => tree), configurable: true });
    await act(async () => { container.querySelector<HTMLButtonElement>('.inline-error button')!.click(); });
    await act(async () => { await wait(20); });
    expect(container.textContent).not.toContain('书签更新失败');
    await act(async () => { root.unmount(); });
    container.remove();
  });
});
