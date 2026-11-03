import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COMMANDS } from '../src/shared/constants';
import { App } from '../src/sidepanel/App';
import { BookmarkSearchPage } from '../src/sidepanel/pages/BookmarkSearchPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bookmark shortcut panel', () => {
  it('opens the global panel for the command window without waiting for session storage', async () => {
    let onCommand: ((command: string, tab?: chrome.tabs.Tab) => void) | undefined;
    let finishStorage!: () => void;
    const storageSet = vi.fn(() => new Promise<void>((resolve) => { finishStorage = resolve; }));
    const open = vi.fn(async () => {});
    const setOptions = vi.fn(async () => {});
    vi.stubGlobal('chrome', {
      commands: { onCommand: { addListener: (listener: typeof onCommand) => { onCommand = listener; } } },
      runtime: {
        onMessage: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
      },
      contextMenus: { onClicked: { addListener: () => {} } },
      storage: { session: { set: storageSet, get: async () => ({}), remove: async () => {} } },
      sidePanel: { open, setOptions, setPanelBehavior: async () => {} },
    });

    await import('../src/background/service-worker');
    onCommand!(COMMANDS.openBookmarks, { id: 7, windowId: 42 } as chrome.tabs.Tab);

    expect(open).toHaveBeenCalledWith({ windowId: 42 });
    expect(setOptions).not.toHaveBeenCalled();
    expect(storageSet).toHaveBeenCalledWith({
      openBookmarkSearch: { windowId: 42, requestId: expect.any(String) },
    });
    finishStorage();
  });

  it('waits for the new tab before closing the same window panel', async () => {
    let finishTab!: (tab: chrome.tabs.Tab) => void;
    const create = vi.fn(() => new Promise<chrome.tabs.Tab>((resolve) => { finishTab = resolve; }));
    const close = vi.fn(async () => {});
    const event = { addListener: () => {}, removeListener: () => {} };
    vi.stubGlobal('chrome', {
      bookmarks: {
        getTree: async () => [{ id: 'root', title: '', children: [{ id: '1', title: 'Example', url: 'https://example.com' }] }],
        onCreated: event, onRemoved: event, onChanged: event, onMoved: event,
      },
      tabs: { create },
      sidePanel: { close },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(BookmarkSearchPage, { focusToken: 1, onBack: () => {} })); });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索浏览器书签"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Example');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const result = container.querySelector<HTMLElement>('[role="option"]')!;
    expect(result).not.toBeNull();
    await act(async () => { result.click(); });
    expect(create).toHaveBeenCalledWith({ url: 'https://example.com', active: true });
    expect(close).not.toHaveBeenCalled();

    await act(async () => { finishTab({ id: 9, windowId: 42 } as chrome.tabs.Tab); });
    expect(close).toHaveBeenCalledWith({ windowId: 42 });
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('closes with one Escape press from a focused result, or the header close button', async () => {
    const close = vi.fn(async () => {});
    const onBack = vi.fn();
    const event = { addListener: () => {}, removeListener: () => {} };
    vi.stubGlobal('chrome', {
      bookmarks: {
        getTree: async () => [{ id: 'root', title: '', children: [{ id: '1', title: 'Example', url: 'https://example.com' }] }],
        onCreated: event, onRemoved: event, onChanged: event, onMoved: event,
      },
      windows: { getCurrent: async () => ({ id: 42 }) },
      sidePanel: { close },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(BookmarkSearchPage, { focusToken: 1, onBack })); });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索浏览器书签"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Example');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const result = container.querySelector<HTMLElement>('[role="option"]')!;
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => {
      result.dispatchEvent(escape);
      await wait(10);
    });
    expect(escape.defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledWith({ windowId: 42 });
    expect(onBack).not.toHaveBeenCalled();
    expect(input.value).toBe('Example');

    close.mockClear();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="关闭书签搜索侧栏"]')!.click(); });
    expect(close).toHaveBeenCalledWith({ windowId: 42 });
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('opens search from a shortcut in this window even while clipboard data is unavailable', async () => {
    const event = { addListener: () => {}, removeListener: () => {} };
    const remove = vi.fn(async () => {});
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: () => new Promise(() => {}) },
        session: {
          get: async () => ({ openBookmarkSearch: { windowId: 42, requestId: 'shortcut-1' } }),
          remove,
        },
        onChanged: event,
      },
      windows: { getCurrent: async () => ({ id: 42 }) },
      bookmarks: {
        getTree: async () => [],
        onCreated: event, onRemoved: event, onChanged: event, onMoved: event,
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(App)); });
    await vi.waitFor(() => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索浏览器书签"]');
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
    });
    expect(remove).toHaveBeenCalledWith('openBookmarkSearch');
    await act(async () => { root.unmount(); });
    container.remove();
  });
});
