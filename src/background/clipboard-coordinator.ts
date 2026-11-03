import { CLIPBOARD_COMMANDS, isClipboardCommand } from '../shared/messaging/clipboard-commands';
import type { FormClipboardItem, FormScanResult } from '../modules/form-clipboard/clipboard-types';
import type { ClipboardCommand, ClipboardCommandResult } from '../shared/messaging/clipboard-commands';
import type { ClipboardService } from '../modules/form-clipboard/clipboard-service';

/**
 * 后台持久化协调器：所有 formClipboard 写入在这里按接收顺序串行执行
 * 「读取最新状态 → 校验 → 修改 → 等待 storage.local.set 完成」。
 * 一次失败只让本次请求失败，队列继续处理后续请求。
 */
export class ClipboardWriteCoordinator {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly service: ClipboardService) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  capture(scan: FormScanResult): Promise<FormClipboardItem> {
    return this.enqueue(() => this.service.capture(scan));
  }

  handle(command: ClipboardCommand): Promise<ClipboardCommandResult> {
    return this.enqueue(async (): Promise<ClipboardCommandResult> => {
      try {
        switch (command.type) {
          case CLIPBOARD_COMMANDS.capture:
            return { ok: true, item: await this.service.capture(command.scan) };
          case CLIPBOARD_COMMANDS.saveDetails:
            await this.service.saveDetails(command.id, command.details);
            return { ok: true };
          case CLIPBOARD_COMMANDS.removeItem:
            await this.service.remove(command.id);
            return { ok: true };
          case CLIPBOARD_COMMANDS.clearHistory:
            await this.service.clear();
            return { ok: true };
          case CLIPBOARD_COMMANDS.setReplacementEnabled:
            await this.service.setReplacementEnabled(command.enabled);
            return { ok: true };
          case CLIPBOARD_COMMANDS.saveReplacementRules:
            await this.service.saveReplacementRules(command.rules, command.expectedRules);
            return { ok: true };
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }
}

/** 侧栏/弹窗等扩展自身页面才允许写命令；内容脚本的消息只保留动作触发。 */
export const isExtensionPageSender = (sender: chrome.runtime.MessageSender): boolean =>
  sender.id === chrome.runtime.id && !sender.tab &&
  typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

export const registerClipboardCommands = (coordinator: ClipboardWriteCoordinator): void => {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isClipboardCommand(message)) return false;
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: '表单剪贴板写入只能由扩展页面发起。' });
      return false;
    }
    void coordinator.handle(message).then(sendResponse);
    return true;
  });
};
