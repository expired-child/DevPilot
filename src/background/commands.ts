import { COMMANDS, SHORTCUT_ACTIONS } from '../shared/constants';

export interface CommandHandlers {
  copy(tab?: chrome.tabs.Tab): Promise<void>;
  paste(tab?: chrome.tabs.Tab): Promise<void>;
}

export const registerCommands = (handlers: CommandHandlers): void => {
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === COMMANDS.copy) {
      void handlers.copy(tab);
    }
    if (command === COMMANDS.paste) {
      void handlers.paste(tab);
    }
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const type = typeof message === 'object' && message !== null && 'type' in message ? message.type : null;
    if (type !== SHORTCUT_ACTIONS.copy && type !== SHORTCUT_ACTIONS.paste) {
      return false;
    }

    const operation = type === SHORTCUT_ACTIONS.copy ? handlers.copy(sender.tab) : handlers.paste(sender.tab);
    void operation.then(() => sendResponse({ ok: true })).catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : '快捷键执行失败' });
    });
    return true;
  });
};
