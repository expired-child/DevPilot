import { ClipboardService } from '../modules/form-clipboard/clipboard-service';
import { ChromeClipboardRepository } from '../modules/form-clipboard/clipboard-repository';
import { PENDING_PASTE_KEY } from '../shared/constants';
import { getActiveTab, sendToTab } from '../shared/messaging/tab-messaging';
import { registerCommands, type CommandHandlers } from './commands';
import { registerContextMenus } from './context-menu';

const clipboard = new ClipboardService(new ChromeClipboardRepository());

const targetTab = async (tab?: chrome.tabs.Tab): Promise<chrome.tabs.Tab> =>
  tab?.id ? tab : getActiveTab();

const copy = async (tab?: chrome.tabs.Tab): Promise<void> => {
  const currentTab = await targetTab(tab);
  try {
    const response = await sendToTab(currentTab.id!, { type: 'SCAN_FORM' });
    if (!response.ok || !('scan' in response)) {
      throw new Error(response.ok ? '未获取到表单' : response.error);
    }
    if (response.scan.fields.length === 0) {
      throw new Error('当前页面没有可复制的表单字段');
    }
    const item = await clipboard.capture(response.scan);
    await sendToTab(currentTab.id!, {
      type: 'SHOW_TOAST',
      message: `已复制表单 · ${item.name} · ${item.fields.length} 个字段`,
    });
  } catch (error) {
    try {
      await sendToTab(currentTab.id!, {
        type: 'SHOW_TOAST',
        tone: 'error',
        message: error instanceof Error ? error.message : '复制表单失败',
      });
    } catch {
      // Chrome 内置页面不允许内容脚本运行，此时无法展示页内提示。
    }
  }
};

const paste = async (tab?: chrome.tabs.Tab): Promise<void> => {
  const currentTab = await targetTab(tab);
  const item = await clipboard.getCurrent();
  if (!item) {
    try {
      await sendToTab(currentTab.id!, { type: 'SHOW_TOAST', tone: 'error', message: '表单剪贴板为空' });
    } catch {
      // 交由用户打开 Side Panel 查看空状态。
    }
    return;
  }

  await chrome.storage.session.set({ [PENDING_PASTE_KEY]: item.id });
  await chrome.sidePanel.open({ tabId: currentTab.id! });
};

const handlers: CommandHandlers = { copy, paste };

registerCommands(handlers);
registerContextMenus(handlers);
