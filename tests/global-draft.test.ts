import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/sidepanel/App';
import { defaultClipboardState } from '../src/modules/form-clipboard/clipboard-repository';
import { defaultReplacementRules } from '../src/modules/form-clipboard/replacement-service';
import type { FormClipboardState, ReplacementRule } from '../src/modules/form-clipboard/clipboard-types';
import { globalDraftKey, loadGlobalDraft, saveGlobalDraft, sameRules } from '../src/sidepanel/global-draft-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const event = { addListener: () => {}, removeListener: () => {} };

const rule = (search: string): ReplacementRule => ({ mode: 'text', search, replacement: 'x' });

interface SetupOptions {
  localState?: FormClipboardState;
  sessionDraft?: { baseRules: ReplacementRule[]; draft: ReplacementRule[]; savedAt: number };
}

const setupChrome = (options: SetupOptions = {}) => {
  const commands: Array<Record<string, unknown>> = [];
  const session: Record<string, unknown> = {};
  let localState = structuredClone(options.localState ?? defaultClipboardState());
  const storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void> = [];
  if (options.sessionDraft) session[globalDraftKey(42)] = structuredClone(options.sessionDraft);
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'ext-1',
      onMessage: event,
      sendMessage: vi.fn(async (message: Record<string, unknown>) => {
        commands.push(message);
        return { ok: true };
      }),
    },
    storage: {
      local: { get: async () => ({ formClipboard: structuredClone(localState) }) },
      session: {
        get: async (key: string) => (key in session ? { [key]: structuredClone(session[key]) } : {}),
        set: async (items: Record<string, unknown>) => { Object.assign(session, items); },
        remove: async (key: string) => { delete session[key]; },
      },
      onChanged: {
        addListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => storageListeners.push(listener),
        removeListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => {
          const index = storageListeners.indexOf(listener);
          if (index >= 0) storageListeners.splice(index, 1);
        },
      },
    },
    windows: { getCurrent: async () => ({ id: 42 }) },
    bookmarks: { getTree: async () => [], onCreated: event, onRemoved: event, onChanged: event, onMoved: event },
    sidePanel: { close: async () => {}, open: async () => {} },
    tabs: { create: async () => ({ id: 9, windowId: 42 }) },
  });
  return {
    commands, session,
    setLocalState: (next: FormClipboardState): void => {
      localState = structuredClone(next);
      for (const listener of [...storageListeners]) listener({ formClipboard: { newValue: structuredClone(next) } }, 'local');
    },
  };
};

const renderApp = async (): Promise<{ container: HTMLElement; root: Root }> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(App)); });
  await act(async () => { await wait(20); });
  return { container, root };
};

const clickButton = async (container: HTMLElement, match: (button: HTMLButtonElement) => boolean): Promise<void> => {
  const button = [...container.querySelectorAll('button')].find(match);
  if (!button) throw new Error('button not found');
  await act(async () => { button.click(); });
};

const addDraftRule = async (container: HTMLElement, search: string): Promise<void> => {
  await act(async () => { container.querySelector<HTMLElement>('.replacement-editor summary')!.click(); });
  await clickButton(container, (button) => button.textContent === '添加替换规则');
  const searchInput = container.querySelector<HTMLTextAreaElement>('.replacement-rule textarea[placeholder="a"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(searchInput, search);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('global draft store', () => {
  it('round-trips a draft record under the window key and removes it on clear', async () => {
    const store: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: { session: {
        get: async (key: string) => (key in store ? { [key]: structuredClone(store[key]) } : {}),
        set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
        remove: async (key: string) => { delete store[key]; },
      } },
    });

    expect(await loadGlobalDraft(7)).toBeNull();
    await saveGlobalDraft(7, { baseRules: [], draft: [rule('a')], savedAt: 5 });
    expect(await loadGlobalDraft(7)).toMatchObject({ draft: [{ search: 'a' }] });
    expect(await loadGlobalDraft(8)).toBeNull(); // 另一个窗口读不到
    await saveGlobalDraft(7, null);
    expect(await loadGlobalDraft(7)).toBeNull();
  });

  it('compares rule lists structurally', () => {
    expect(sameRules([rule('a')], [rule('a')])).toBe(true);
    expect(sameRules([rule('a')], [rule('b')])).toBe(false);
  });

  it('serializes a pending draft write before clearing it', async () => {
    const store: Record<string, unknown> = {};
    const operations: string[] = [];
    vi.stubGlobal('chrome', {
      storage: { session: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          operations.push('set:start');
          await wait(20);
          Object.assign(store, items);
          operations.push('set:end');
        },
        remove: async (key: string) => { operations.push('remove'); delete store[key]; },
      } },
    });
    await Promise.all([
      saveGlobalDraft(7, { baseRules: [], draft: [rule('old')], savedAt: 1 }),
      saveGlobalDraft(7, null),
    ]);
    expect(operations).toEqual(['set:start', 'set:end', 'remove']);
    expect(await loadGlobalDraft(7)).toBeNull();
  });
});

describe('global replacement draft in the sidepanel', () => {
  it('keeps the draft when navigating away and back, and discards on demand', async () => {
    const { session } = setupChrome();
    const { container, root } = await renderApp();

    await addDraftRule(container, 'demo');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '放弃修改')).toBe(true);

    await clickButton(container, (button) => button.textContent?.includes('书签搜索'));
    await clickButton(container, (button) => button.textContent === '表单剪贴板');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '放弃修改')).toBe(true);
    expect(container.querySelector('.replacement-editor summary')!.textContent).toContain('2 条规则');
    expect(Object.keys(session).some((key) => key.startsWith('globalReplacementDraft:'))).toBe(true);

    await clickButton(container, (button) => button.textContent === '放弃修改');
    expect(container.querySelector('.replacement-editor summary')!.textContent).toContain('1 条规则');
    expect(Object.keys(session).some((key) => key.startsWith('globalReplacementDraft:'))).toBe(false);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('restores a session draft and flags a conflict when official rules moved on', async () => {
    const record = { baseRules: defaultReplacementRules(), draft: [rule('stale')], savedAt: 1 };
    setupChrome({ sessionDraft: record });
    const { container, root } = await renderApp();
    await act(async () => { await wait(20); });

    expect(container.querySelector('.replacement-editor summary')!.textContent).toContain('1 条规则');
    expect(container.textContent).not.toContain('正式规则已被其他窗口更新');
    await act(async () => { root.unmount(); });
    container.remove();

    // 另一窗口已保存不同规则：恢复时提示核对，不能静默当作当前配置。
    const state = defaultClipboardState();
    state.settings.replacementRules = [rule('updated')];
    setupChrome({ localState: state, sessionDraft: record });
    const second = await renderApp();
    await act(async () => { await wait(20); });
    expect(second.container.textContent).toContain('正式规则已在其他窗口更新');
    await act(async () => { second.root.unmount(); });
    second.container.remove();
  });

  it('saves through the background command and clears the draft afterwards', async () => {
    const { commands } = setupChrome();
    const { container, root } = await renderApp();

    await addDraftRule(container, 'demo');
    await clickButton(container, (button) => button.textContent === '保存全局规则');
    await act(async () => { await wait(20); });

    expect(commands.some((command) => command.type === 'SAVE_REPLACEMENT_RULES')).toBe(true);
    expect(commands.find((command) => command.type === 'SAVE_REPLACEMENT_RULES')?.expectedRules).toEqual(defaultReplacementRules());
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '放弃修改')).toBe(false);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('detects a live rule change and requires an explicit rebase before saving', async () => {
    const { commands, setLocalState } = setupChrome();
    const { container, root } = await renderApp();
    await addDraftRule(container, 'demo');

    const updated = defaultClipboardState();
    updated.settings.replacementRules = [rule('new-from-other-window')];
    await act(async () => { setLocalState(updated); await wait(20); });
    expect(container.textContent).toContain('正式规则已在其他窗口更新');
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === '保存全局规则')!;
    expect(save.disabled).toBe(true);

    await clickButton(container, (button) => button.textContent === '我已核对，允许覆盖');
    expect(save.disabled).toBe(false);
    await clickButton(container, (button) => button.textContent === '保存全局规则');
    expect(commands.find((command) => command.type === 'SAVE_REPLACEMENT_RULES')?.expectedRules)
      .toEqual(updated.settings.replacementRules);
    await act(async () => { root.unmount(); });
    container.remove();
  });
});
