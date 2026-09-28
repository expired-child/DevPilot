import { COMMANDS, SHORTCUT_ACTIONS, SHORTCUT_BINDINGS_REQUEST } from '../shared/constants';

export interface CommandHandlers {
  copy(tab?: chrome.tabs.Tab): Promise<void>;
  paste(tab?: chrome.tabs.Tab): Promise<void>;
  openBookmarks(tab?: chrome.tabs.Tab): Promise<void>;
}

/**
 * 同一次按键可能同时命中 chrome.commands 与页面 keydown 兜底通道，
 * 这里用短窗口去重，避免一次按键执行两遍（复制会产生重复快照）。
 */
const DEDUPE_WINDOW_MS = 300;
const lastRunAt = new Map<string, number>();

const claimAction = (action: string): boolean => {
  const now = Date.now();
  const previous = lastRunAt.get(action) ?? 0;
  if (now - previous < DEDUPE_WINDOW_MS) {
    return false;
  }
  lastRunAt.set(action, now);
  return true;
};

export const registerCommands = (handlers: CommandHandlers): void => {
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === COMMANDS.copy) {
      if (claimAction(SHORTCUT_ACTIONS.copy)) {
        void handlers.copy(tab);
      }
    }
    if (command === COMMANDS.paste) {
      if (claimAction(SHORTCUT_ACTIONS.paste)) {
        void handlers.paste(tab);
      }
    }
    if (command === COMMANDS.openBookmarks) {
      if (claimAction(SHORTCUT_ACTIONS.openBookmarks)) {
        void handlers.openBookmarks(tab);
      }
    }
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const type = typeof message === 'object' && message !== null && 'type' in message ? message.type : null;
    if (type === SHORTCUT_BINDINGS_REQUEST) {
      void chrome.commands.getAll().then((commands) => {
        const bound = (name: string): boolean => Boolean(commands.find((command) => command.name === name)?.shortcut);
        sendResponse({ ok: true, fallbackCopy: !bound(COMMANDS.copy), fallbackPaste: !bound(COMMANDS.paste) });
      }).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (type !== SHORTCUT_ACTIONS.copy && type !== SHORTCUT_ACTIONS.paste) {
      return false;
    }
    if (!claimAction(type)) {
      sendResponse({ ok: true });
      return true;
    }

    const operation = type === SHORTCUT_ACTIONS.copy ? handlers.copy(sender.tab) : handlers.paste(sender.tab);
    void operation.then(() => sendResponse({ ok: true })).catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : '快捷键执行失败' });
    });
    return true;
  });
};
