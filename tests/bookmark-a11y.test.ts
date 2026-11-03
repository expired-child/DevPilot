import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BookmarkSearchPage } from '../src/sidepanel/pages/BookmarkSearchPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const event = { addListener: () => {}, removeListener: () => {} };

const leaf = (id: string, title: string, url: string): chrome.bookmarks.BookmarkTreeNode =>
  ({ id, title, url, syncing: false });

const tree = [
  leaf('1', 'GitHub', 'https://github.com'),
  leaf('2', 'GitHub Pages', 'https://pages.github.com'),
  leaf('3', 'MDN', 'https://developer.mozilla.org'),
];

const renderPage = async () => {
  vi.stubGlobal('chrome', {
    bookmarks: { getTree: vi.fn(async () => tree), onCreated: event, onRemoved: event, onChanged: event, onMoved: event },
    windows: { getCurrent: async () => ({ id: 42 }) },
    sidePanel: { close: async () => {} },
    tabs: { create: vi.fn(async () => ({ id: 9, windowId: 42 })) },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(BookmarkSearchPage, { focusToken: 1, onBack: () => {} })); });
  await act(async () => { await wait(20); });
  return { container, root, create: vi.mocked(chrome.tabs.create) };
};

const typeQuery = async (container: HTMLElement, query: string): Promise<void> => {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索浏览器书签"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const keyDown = (input: HTMLInputElement, init: KeyboardEventInit): KeyboardEvent => {
  const keyEvent = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(keyEvent);
  return keyEvent;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('bookmark search combobox semantics', () => {
  it('exposes the results as a listbox owned by the combobox with a selected active option', async () => {
    const { container, root } = await renderPage();
    await typeQuery(container, 'GitHub');

    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(input).not.toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe('bookmark-listbox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');

    const listbox = container.querySelector('[role="listbox"]#bookmark-listbox')!;
    expect(listbox).not.toBeNull();
    const options = [...container.querySelectorAll('[role="option"]')];
    expect(options).toHaveLength(2);
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(options[1].getAttribute('aria-selected')).toBe('false');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);

    await act(async () => { keyDown(input, { key: 'ArrowDown' }); });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(input); // 焦点保持在搜索框
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('opens the active option with Enter and ignores keys during IME composition', async () => {
    const { container, root, create } = await renderPage();
    await typeQuery(container, 'GitHub');
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;

    await act(async () => { keyDown(input, { key: 'Enter' }); });
    expect(create).toHaveBeenCalledWith({ url: 'https://github.com', active: true });
    create.mockClear();

    const composed = keyDown(input, { key: 'Enter', isComposing: true });
    expect(composed.defaultPrevented).toBe(false);
    expect(create).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('announces the result count and drops the active option when there are no results', async () => {
    const { container, root } = await renderPage();
    await typeQuery(container, 'GitHub');

    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('找到 2 个书签');

    await typeQuery(container, '不存在的书签');
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(status.textContent).toBe('找到 0 个书签');
    expect(container.querySelector('[role="option"]')).toBeNull();
    await act(async () => { keyDown(input, { key: 'Enter' }); });
    expect(vi.mocked(chrome.tabs.create)).not.toHaveBeenCalled(); // 不指向无效选项
    await act(async () => { root.unmount(); });
    container.remove();
  });
});
