import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerPageShortcuts } from '../src/content/shortcut';
import { registerCommands } from '../src/background/commands';
import { COMMANDS, SHORTCUT_ACTIONS, SHORTCUT_BINDINGS_REQUEST } from '../src/shared/constants';

afterEach(() => { vi.unstubAllGlobals(); });

describe('page shortcut fallback', () => {
  it('uses Chrome command bindings to decide which page fallback remains active', async () => {
    let onMessage: ((message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean) | undefined;
    vi.stubGlobal('chrome', {
      commands: {
        onCommand: { addListener: () => {} },
        getAll: async () => [
          { name: COMMANDS.copy, shortcut: 'Alt+Shift+C' },
          { name: COMMANDS.paste, shortcut: '' },
        ],
      },
      runtime: { onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } } },
    });
    registerCommands({ copy: async () => {}, paste: async () => {}, openBookmarks: async () => {} });
    let response: unknown;
    onMessage!({ type: SHORTCUT_BINDINGS_REQUEST }, {} as chrome.runtime.MessageSender, (value) => { response = value; });
    await vi.waitFor(() => expect(response).toEqual({ ok: true, fallbackCopy: false, fallbackPaste: true }));
  });

  it('does not intercept the old key when Chrome has a shortcut bound', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === SHORTCUT_BINDINGS_REQUEST
      ? { ok: true, fallbackCopy: false, fallbackPaste: false }
      : { ok: true });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const dispose = registerPageShortcuts(() => {});
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const event = new KeyboardEvent('keydown', { key: 'c', altKey: true, shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('uses the default key only when that Chrome command is unbound', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === SHORTCUT_BINDINGS_REQUEST
      ? { ok: true, fallbackCopy: true, fallbackPaste: false }
      : { ok: true });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const dispose = registerPageShortcuts(() => {});
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const copy = new KeyboardEvent('keydown', { key: 'c', altKey: true, shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({ type: SHORTCUT_ACTIONS.copy });

    const paste = new KeyboardEvent('keydown', { key: 'v', altKey: true, shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    dispose();
  });
});
