import { ClipboardService } from '../modules/form-clipboard/clipboard-service';
import { ChromeClipboardRepository } from '../modules/form-clipboard/clipboard-repository';
import { ChromeOrganizerRepository } from '../modules/bookmark-organizer/bookmark-organizer-repository';
import {
  BookmarkOrganizeCoordinator,
  registerBookmarkAutoOrganize,
  registerBookmarkCommands,
} from './bookmark-coordinator';
import { ClipboardWriteCoordinator, registerClipboardCommands } from './clipboard-coordinator';
import { buildFillPlan } from '../modules/form-clipboard/fill-plan-service';
import { topSkipReason } from '../modules/form-clipboard/fill-feedback';
import { createFingerprint } from '../modules/form-clipboard/fingerprint';
import type { FillReport } from '../modules/form-clipboard/clipboard-types';
import { getActiveTab, listFormCandidates, scanScope, sendToTab, uniqueCandidate } from '../shared/messaging/tab-messaging';
import { BOOKMARK_SEARCH_TRIGGER, type BookmarkSearchTrigger } from '../shared/constants';
import { registerCommands, type CommandHandlers } from './commands';
import { registerContextMenus } from './context-menu';

const repository = new ChromeClipboardRepository();
const clipboard = new ClipboardWriteCoordinator(new ClipboardService(repository));
registerClipboardCommands(clipboard);

// 书签整理走独立的命令通道、队列与操作日志，不复用表单剪贴板的任何数据键。
const organizer = new BookmarkOrganizeCoordinator(new ChromeOrganizerRepository());
registerBookmarkCommands(organizer);
// 测试环境或受限上下文可能没有 bookmarks 事件；注册失败不影响其余后台能力。
try {
  registerBookmarkAutoOrganize(organizer);
} catch (error) {
  console.error('[DevPilot] bookmark-auto-organize:setup-failed', error);
}

const targetTab = async (tab?: chrome.tabs.Tab): Promise<chrome.tabs.Tab> => tab?.id ? tab : getActiveTab();

const toast = async (
  tabId: number | undefined,
  message: string,
  tone: 'success' | 'error' = 'success',
  target?: chrome.tabs.MessageSendOptions,
): Promise<void> => {
  if (tabId === undefined) {
    return;
  }
  try {
    await sendToTab(tabId, { type: 'SHOW_TOAST', message, tone }, target);
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

/** 快捷键/右键菜单的目标解析：焦点或弹窗能唯一确定时直接执行，无法唯一确定时不猜测。 */
const resolveActionTarget = async (tabId: number, emptyMessage: string) => {
  const options = (await listFormCandidates(tabId)).filter((option) => option.fieldCount > 0);
  if (options.length === 0) {
    throw new Error(emptyMessage);
  }
  const chosen = uniqueCandidate(options);
  if (!chosen) {
    throw new Error(`当前页面有 ${options.length} 个表单，无法确定目标；请先点击目标表单的输入框，或打开侧栏选择。`);
  }
  return scanScope(tabId, chosen);
};

const copy = async (tab?: chrome.tabs.Tab): Promise<void> => {
  const currentTab = await targetTab(tab);
  try {
    const target = await resolveActionTarget(currentTab.id!, '当前页面没有可复制的表单字段');
    const item = await clipboard.capture(target.scan);
    await toast(currentTab.id, `已复制表单 · ${item.name} · ${item.fields.length} 个字段`, 'success',
      target.documentId ? { documentId: target.documentId } : { frameId: target.frameId });
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
    const state = await repository.get();
    const item = state.history.find((entry) => entry.id === state.currentId);
    if (!item) {
      await toast(tabId, '表单剪贴板为空，请先在 DevPilot 侧栏复制表单', 'error');
      return;
    }
    console.debug('[DevPilot] paste:item', { id: item.id, fields: item.fields.length });

    const target = await resolveActionTarget(tabId!, '当前页面没有可填充的表单字段');
    const { scan } = target;
    console.debug('[DevPilot] paste:target', { fields: scan.fields.length });

    // 用目标页现有值播种已用集合，避免唯一字段后缀与页面当前值撞车。
    const usedValues = scan.fields.flatMap((entry) => (typeof entry.value === 'string' ? [entry.value] : []));
    const plan = buildFillPlan(item, scan.fields, { autoUnique: true, usedValues, settings: state.settings });
    console.debug('[DevPilot] paste:plan', {
      assignments: plan.assignments.length,
      skipped: plan.skipped.length,
      missingVariables: plan.missingVariables,
    });

    // 与预览页一致：只要有缺失变量就不执行任何填充，避免半张表单已改、另一半仍未填写。
    if (plan.missingVariables.length > 0) {
      await toast(tabId, `缺少变量：${plan.missingVariables.join('、')}；请在侧栏预览并填写`, 'error');
      return;
    }

    if (plan.assignments.length === 0) {
      const top = topSkipReason(plan.skipped);
      await toast(tabId, `没有可填充的字段（跳过 ${plan.skipped.length} 个）${top ? `：${top.reason}${top.count > 1 ? ` · ${top.count} 个字段` : ''}` : ''}`, 'error');
      return;
    }

    const response = await sendToTab(tabId!, {
      type: 'APPLY_FIELDS',
      assignments: plan.assignments,
      expectedTarget: {
        url: scan.source.url,
        fingerprint: createFingerprint(scan.source.host, scan.fields),
        scopeId: scan.scopeId,
      },
    }, target.documentId ? { documentId: target.documentId } : { frameId: target.frameId });
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
      `已直接填充（跳过预览）：成功 ${report.success}，跳过 ${report.skipped}，失败 ${report.failed}${detail ? ` · ${detail}` : ''}`,
      report.failed ? 'error' : 'success',
      target.documentId ? { documentId: target.documentId } : { frameId: target.frameId },
    );
  } catch (error) {
    console.error('[DevPilot] paste:failed', error);
    await toast(tabId, errorText(error), 'error');
  }
};

const openBookmarks = async (tab?: chrome.tabs.Tab): Promise<void> => {
  // manifest 声明的是全局侧栏。按窗口打开，避免在按标签配置尚未生效时
  // 调用 open({ tabId }) 出现「No active side panel for tabId」。
  const current = tab?.windowId !== undefined ? tab : await getActiveTab();
  if (current.windowId === undefined) return;
  const trigger: BookmarkSearchTrigger = { windowId: current.windowId, requestId: crypto.randomUUID() };
  // open 必须在快捷键用户手势内发起；写入标记不能先 await。
  const stored = chrome.storage.session.set({ [BOOKMARK_SEARCH_TRIGGER]: trigger });
  const opened = chrome.sidePanel.open({ windowId: current.windowId });
  try {
    await Promise.all([stored, opened]);
  } catch (error) {
    console.error('[DevPilot] openBookmarks:sidePanel-failed', error);
    const value = (await chrome.storage.session.get(BOOKMARK_SEARCH_TRIGGER))[BOOKMARK_SEARCH_TRIGGER] as BookmarkSearchTrigger | undefined;
    if (value?.requestId === trigger.requestId) await chrome.storage.session.remove(BOOKMARK_SEARCH_TRIGGER);
  }
};

const handlers: CommandHandlers = { copy, paste, openBookmarks };

registerCommands(handlers);
registerContextMenus(handlers);
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
  console.error('[DevPilot] sidePanel:setup-failed', error);
});
