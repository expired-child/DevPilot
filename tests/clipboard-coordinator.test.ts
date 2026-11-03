import { describe, expect, it, vi } from 'vitest';

import { ClipboardService } from '../src/modules/form-clipboard/clipboard-service';
import { defaultClipboardState, type ClipboardRepository } from '../src/modules/form-clipboard/clipboard-repository';
import type { FormClipboardState, FormScanResult } from '../src/modules/form-clipboard/clipboard-types';
import { ClipboardWriteCoordinator, isExtensionPageSender, registerClipboardCommands } from '../src/background/clipboard-coordinator';
import { CLIPBOARD_COMMANDS, isClipboardCommand } from '../src/shared/messaging/clipboard-commands';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const scan = (name: string): FormScanResult => ({
  suggestedName: name,
  source: { url: `https://demo.example/${name}`, host: 'demo.example' },
  fields: [{ key: 'name:name', name: 'name', type: 'text', value: name }],
});

/**
 * 共享存储仓库，读写延迟按调用顺序消费：模拟“后台复制”与“侧栏改开关”
 * 同时开始时，两种完成顺序都会出现的真实竞争。
 */
class ScriptedRepository implements ClipboardRepository {
  state: FormClipboardState = defaultClipboardState();
  private getIndex = 0;
  private setIndex = 0;
  constructor(
    private readonly getDelays: number[],
    private readonly setDelays: number[],
    private failFirstSet = false,
  ) {}
  async get(): Promise<FormClipboardState> {
    await wait(this.getDelays[Math.min(this.getIndex++, this.getDelays.length - 1)]);
    return structuredClone(this.state);
  }
  async save(next: FormClipboardState): Promise<void> {
    await wait(this.setDelays[Math.min(this.setIndex++, this.setDelays.length - 1)]);
    if (this.failFirstSet) {
      this.failFirstSet = false;
      throw new Error('存储写入失败');
    }
    this.state = structuredClone(next);
  }
}

describe('clipboard write coordinator', () => {
  it('keeps both a concurrent capture and replacement toggle in either completion order', async () => {
    const captureFirst = new ScriptedRepository([40, 0], [0, 40]);
    const toggleFirst = new ScriptedRepository([40, 0], [0, 40]);
    const first = new ClipboardWriteCoordinator(new ClipboardService(captureFirst));
    const second = new ClipboardWriteCoordinator(new ClipboardService(toggleFirst));

    await Promise.all([
      first.handle({ type: CLIPBOARD_COMMANDS.capture, scan: scan('表单一') }),
      first.handle({ type: CLIPBOARD_COMMANDS.setReplacementEnabled, enabled: true }),
    ]);
    await Promise.all([
      second.handle({ type: CLIPBOARD_COMMANDS.setReplacementEnabled, enabled: true }),
      second.handle({ type: CLIPBOARD_COMMANDS.capture, scan: scan('表单一') }),
    ]);

    for (const repository of [captureFirst, toggleFirst]) {
      expect(repository.state.history).toHaveLength(1);
      expect(repository.state.settings.replacementEnabled).toBe(true);
    }
  });

  it('runs two concurrent captures without losing either record', async () => {
    const repository = new ScriptedRepository([10], [10]);
    const coordinator = new ClipboardWriteCoordinator(new ClipboardService(repository));

    const items = await Promise.all([
      coordinator.capture(scan('first')),
      coordinator.capture(scan('second')),
    ]);

    expect(new Set(items.map(({ id }) => id)).size).toBe(2);
    expect(repository.state.history).toHaveLength(2);
    expect(repository.state.currentId).toBeTruthy();
  });

  it('fails only the request whose storage write failed and keeps serving the next one', async () => {
    const repository = new ScriptedRepository([0], [0], true);
    const coordinator = new ClipboardWriteCoordinator(new ClipboardService(repository));

    const failed = await coordinator.handle({ type: CLIPBOARD_COMMANDS.capture, scan: scan('lost') });
    expect(failed).toMatchObject({ ok: false });

    const retry = await coordinator.handle({ type: CLIPBOARD_COMMANDS.capture, scan: scan('kept') });
    expect(retry).toMatchObject({ ok: true });
    expect(repository.state.history.map(({ name }) => name)).toEqual(['kept']);
  });

  it('reports rule validation failures through the command result', async () => {
    const coordinator = new ClipboardWriteCoordinator(new ClipboardService(new ScriptedRepository([0], [0])));
    const result = await coordinator.handle({
      type: CLIPBOARD_COMMANDS.saveReplacementRules,
      rules: [{ mode: 'regex', search: '[', replacement: '' }],
      expectedRules: defaultClipboardState().settings.replacementRules ?? [],
    });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects an outdated rule baseline rather than overwriting another window', async () => {
    const repository = new ScriptedRepository([0], [0]);
    const coordinator = new ClipboardWriteCoordinator(new ClipboardService(repository));
    const baseline = structuredClone(repository.state.settings.replacementRules ?? []);
    const first = await coordinator.handle({
      type: CLIPBOARD_COMMANDS.saveReplacementRules,
      rules: [{ mode: 'text', search: 'a', replacement: 'b' }], expectedRules: baseline,
    });
    const stale = await coordinator.handle({
      type: CLIPBOARD_COMMANDS.saveReplacementRules,
      rules: [{ mode: 'text', search: 'a', replacement: 'c' }], expectedRules: baseline,
    });
    expect(first).toMatchObject({ ok: true });
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining('其他窗口更新') });
    expect(repository.state.settings.replacementRules?.[0].replacement).toBe('b');
  });
});

describe('clipboard command gate', () => {
  it('accepts extension page senders and rejects content scripts or foreign extensions', () => {
    vi.stubGlobal('chrome', { runtime: { id: 'ext-1', getURL: () => 'chrome-extension://ext-1/' } });
    expect(isExtensionPageSender({ id: 'ext-1', url: 'chrome-extension://ext-1/sidepanel.html' } as chrome.runtime.MessageSender)).toBe(true);
    expect(isExtensionPageSender({ id: 'ext-1', url: 'https://example.com', tab: { id: 3 } } as chrome.runtime.MessageSender)).toBe(false);
    expect(isExtensionPageSender({ id: 'other-ext', url: 'chrome-extension://other-ext/page.html' } as chrome.runtime.MessageSender)).toBe(false);
    vi.unstubAllGlobals();
  });

  it('accepts complete commands and rejects unknown or partial ones', () => {
    expect(isClipboardCommand({ type: CLIPBOARD_COMMANDS.clearHistory })).toBe(true);
    expect(isClipboardCommand({ type: CLIPBOARD_COMMANDS.capture, scan: scan('a') })).toBe(true);
    expect(isClipboardCommand({
      type: CLIPBOARD_COMMANDS.saveDetails, id: 'item-1',
      details: { name: 'n', fields: [], uniqueFieldKeys: [], excludedFieldKeys: [], pinned: false },
    })).toBe(true);

    expect(isClipboardCommand({ type: 'UNKNOWN_COMMAND' })).toBe(false);
    expect(isClipboardCommand({ type: CLIPBOARD_COMMANDS.capture, scan: { source: {} } })).toBe(false);
    expect(isClipboardCommand({ type: CLIPBOARD_COMMANDS.capture, scan: scan('a'), extra: true })).toBe(true);
    expect(isClipboardCommand({ type: CLIPBOARD_COMMANDS.capture, scan: { ...scan('a'), fields: [{}] } })).toBe(false);
    expect(isClipboardCommand({ type: CLIPBOARD_COMMANDS.capture, scan: { ...scan('a'), source: { host: 'demo.example' } } })).toBe(false);
    expect(isClipboardCommand({ type: CLIPBOARD_COMMANDS.removeItem })).toBe(false);
    expect(isClipboardCommand({ type: CLIPBOARD_COMMANDS.removeItem, id: '' })).toBe(false);
    expect(isClipboardCommand({ type: CLIPBOARD_COMMANDS.setReplacementEnabled, enabled: 'yes' })).toBe(false);
    expect(isClipboardCommand({ type: CLIPBOARD_COMMANDS.saveReplacementRules, rules: [{ search: 'a' }] })).toBe(false);
    expect(isClipboardCommand({ type: CLIPBOARD_COMMANDS.saveReplacementRules, rules: [], expectedRules: [{ mode: 'invalid', search: 'a', replacement: '' }] })).toBe(false);
    expect(isClipboardCommand(null)).toBe(false);
    expect(isClipboardCommand('CAPTURE_FORM')).toBe(false);
  });

  it('registers a runtime listener that serves extension pages only', async () => {
    let listener: ((message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean) | undefined;
    vi.stubGlobal('chrome', {
      runtime: { id: 'ext-1', getURL: () => 'chrome-extension://ext-1/', onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    });
    const repository = new ScriptedRepository([0], [0]);
    registerClipboardCommands(new ClipboardWriteCoordinator(new ClipboardService(repository)));

    const respond = (sender: chrome.runtime.MessageSender): Promise<{ ok: boolean; item?: { name: string }; error?: string }> =>
      new Promise((resolve) => {
        listener!({ type: CLIPBOARD_COMMANDS.capture, scan: scan('页面表单') }, sender, (response: unknown) =>
          resolve(response as { ok: boolean; item?: { name: string }; error?: string }));
      });

    const accepted = await respond({ id: 'ext-1', url: 'chrome-extension://ext-1/sidepanel.html' });
    expect(accepted).toMatchObject({ ok: true, item: { name: '页面表单' } });
    expect(repository.state.history).toHaveLength(1);

    const rejected = await respond({ id: 'ext-1', url: 'https://example.com', tab: { id: 5 } } as chrome.runtime.MessageSender);
    expect(rejected).toMatchObject({ ok: false });
    expect(repository.state.history).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
