import { CONTEXT_MENUS } from '../shared/constants';
import type { CommandHandlers } from './commands';

export const registerContextMenus = (handlers: CommandHandlers): void => {
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.contextMenus.removeAll().then(() => {
      chrome.contextMenus.create({ id: CONTEXT_MENUS.root, title: 'DevPilot', contexts: ['page', 'editable'] });
      chrome.contextMenus.create({
        id: CONTEXT_MENUS.copy,
        parentId: CONTEXT_MENUS.root,
        title: '复制当前表单',
        contexts: ['page', 'editable'],
      });
      chrome.contextMenus.create({
        id: CONTEXT_MENUS.paste,
        parentId: CONTEXT_MENUS.root,
        title: '粘贴最近表单',
        contexts: ['page', 'editable'],
      });
    });
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === CONTEXT_MENUS.copy) {
      void handlers.copy(tab);
    }
    if (info.menuItemId === CONTEXT_MENUS.paste) {
      void handlers.paste(tab);
    }
  });
};
