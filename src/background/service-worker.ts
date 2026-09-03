import { ClipboardService } from '../modules/form-clipboard/clipboard-service';
import { ChromeClipboardRepository } from '../modules/form-clipboard/clipboard-repository';
import { buildFillPlan } from '../modules/form-clipboard/fill-plan-service';
import type { FillReport, FormScanResult } from '../modules/form-clipboard/clipboard-types';
import { getActiveTab, sendToTab } from '../shared/messaging/tab-messaging';
import { registerCommands, type CommandHandlers } from './commands';
import { registerContextMenus } from './context-menu';

const clipboard = new ClipboardService(new ChromeClipboardRepository());

const targetTab = async (tab?: chrome.tabs.Tab): Promise<chrome.tabs.Tab> => tab?.id ? tab : getActiveTab();

const toast = async (tabId: number | undefined, message: string, tone: 'success' | 'error' = 'success'): Promise<void> => {
  if (tabId === undefined) {
    return;
  }
  try {
    await sendToTab(tabId, { type: 'SHOW_TOAST', message, tone });
  } catch {
    // Chrome 内置页面不允许内容脚本运行，页内提示不可用；
    // 至少通过工具栏徽标告知用户扩展有反馈，避免完全静默。
    flashBadge();
  }
};

const flashBadge = (): void => {
  void chrome.action.setBadgeText({ text: '!' }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ color: '#c83f49' }).catch(() => {});
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }, 4000);
};

const errorText = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return /Receiving end does not exist|Could not establish connection/.test(message)
    ? '当前页面不允许扩展访问，请切换到普通网页后重试。'
    : message;
};

const scanTab = async (tabId: number): Promise<FormScanResult> => {
  const response = await sendToTab(tabId, { type: 'SCAN_FORM' });
  if (!response.ok || !('scan' in response)) {
    throw new Error(response.ok ? '未获取到表单' : response.error);
  }
  return response.scan;
};

const copy = async (tab?: chrome.tabs.Tab): Promise<void> => {
  const currentTab = await targetTab(tab);
  try {
    const scan = await scanTab(currentTab.id!);
    if (scan.fields.length === 0) {
      throw new Error('当前页面没有可复制的表单字段');
    }
    const item = await clipboard.capture(scan);
    await toast(currentTab.id, `已复制表单 · ${item.name} · ${item.fields.length} 个字段`);
  } catch (error) {
    console.error('[DevPilot] copy:failed', error);
    await toast(currentTab.id, errorText(error), 'error');
  }
};

const paste = async (tab?: chrome.tabs.Tab): Promise<void> => {
  const currentTab = await targetTab(tab);
  const tabId = currentTab.id;
  try {
    console.debug('[DevPilot] paste:start', { tabId });
    const item = await clipboard.getCurrent();
    if (!item) {
      await toast(tabId, '表单剪贴板为空，请先按 Alt+Shift+C 复制', 'error');
      return;
    }
    console.debug('[DevPilot] paste:item', { id: item.id, fields: item.fields.length });

    const scan = await scanTab(tabId!);
    console.debug('[DevPilot] paste:target', { fields: scan.fields.length });

    // 用目标页现有值播种已用集合，避免唯一字段后缀与页面当前值撞车。
    const usedValues = scan.fields.flatMap((entry) => (typeof entry.value === 'string' ? [entry.value] : []));
    const plan = buildFillPlan(item, scan.fields, { autoUnique: true, usedValues });
    console.debug('[DevPilot] paste:plan', {
      assignments: plan.assignments.length,
      skipped: plan.skipped.length,
      missingVariables: plan.missingVariables,
    });

    if (plan.assignments.length === 0) {
      await toast(tabId, `没有可填充的字段（跳过 ${plan.skipped.length} 个）`, 'error');
      return;
    }

    const response = await sendToTab(tabId!, { type: 'APPLY_FIELDS', assignments: plan.assignments });
    if (!response.ok || !('report' in response)) {
      throw new Error(response.ok ? '未获取到填充结果' : response.error);
    }

    const report: FillReport = {
      ...response.report,
      skipped: response.report.skipped + plan.skipped.length,
      issues: [...response.report.issues, ...plan.skipped],
    };
    console.debug('[DevPilot] paste:done', report);

    const detail = report.issues.slice(0, 2).map((issue) => `${issue.label}：${issue.reason}`).join('；');
    await toast(
      tabId,
      `填充完成：成功 ${report.success}，跳过 ${report.skipped}，失败 ${report.failed}${detail ? ` · ${detail}` : ''}`,
      report.failed ? 'error' : 'success',
    );
  } catch (error) {
    console.error('[DevPilot] paste:failed', error);
    await toast(tabId, errorText(error), 'error');
  }
};

const handlers: CommandHandlers = { copy, paste };

registerCommands(handlers);
registerContextMenus(handlers);
