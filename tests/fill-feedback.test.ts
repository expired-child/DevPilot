import { afterEach, describe, expect, it, vi } from 'vitest';

import { topSkipReason } from '../src/modules/form-clipboard/fill-feedback';
import { defaultClipboardState } from '../src/modules/form-clipboard/clipboard-repository';
import type { FormClipboardItem, FormClipboardState } from '../src/modules/form-clipboard/clipboard-types';
import { COMMANDS } from '../src/shared/constants';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const event = { addListener: () => {}, removeListener: () => {} };

const itemWith = (fields: FormClipboardItem['fields'], variables?: Record<string, string>): FormClipboardItem => ({
  id: 'item-1',
  name: '测试表单',
  createdAt: 0,
  updatedAt: 0,
  source: { url: 'https://demo.example/a', host: 'demo.example' },
  fields,
  variables,
  fingerprint: 'test',
});

const stateWith = (item: FormClipboardItem): FormClipboardState => ({
  ...defaultClipboardState(),
  currentId: item.id,
  history: [item],
});

/** 装配当前 chrome 全局：捕获发往页面的每条消息；返回触发的命令入口。 */
const stubChrome = (item: FormClipboardItem, targetFields: FormClipboardItem['fields']) => {
  const sentRequests: Array<{ type?: string; message?: string }> = [];
  const targetScan = {
    suggestedName: '目标表单',
    source: { url: 'https://demo.example/b', host: 'demo.example', title: '目标页' },
    fields: targetFields,
    scopeId: 'scope-1',
  };
  vi.stubGlobal('chrome', {
    commands: { onCommand: event },
    runtime: { id: 'ext-1', onInstalled: event, onMessage: event },
    contextMenus: { onClicked: event },
    storage: {
      local: { get: async () => ({ formClipboard: structuredClone(stateWith(item)) }), set: async () => {} },
      session: { set: async () => {}, get: async () => ({}), remove: async () => {} },
      onChanged: event,
    },
    sidePanel: { open: async () => {}, setPanelBehavior: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'main-doc' }] },
    tabs: {
      sendMessage: vi.fn(async (_tabId: number, request: { type?: string }) => {
        sentRequests.push(request);
        if (request.type === 'LIST_FORM_CANDIDATES') {
          return targetFields.length === 0 ? { ok: true, candidates: [] } : {
            ok: true,
            candidates: [{
              scopeId: 'scope-1', title: '目标表单', fieldCount: targetFields.length,
              fieldLabels: [], dialog: false, focused: false, source: targetScan.source,
            }],
          };
        }
        if (request.type === 'SCAN_FORM') {
          return { ok: true, focused: false, scan: structuredClone(targetScan) };
        }
        if (request.type === 'APPLY_FIELDS') {
          return { ok: true, report: { success: 1, skipped: 0, failed: 0, issues: [] } };
        }
        return { ok: true };
      }),
    },
  });
  return sentRequests;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hotkey paste guard', () => {
  it('blocks missing variables, explains skips, and still fills when everything resolves', async () => {
    // service-worker 每个测试文件只注册一次；三个场景复用同一命令入口，
    // 通过重设 chrome 全局与快捷键去重窗口隔离彼此。
    let onCommand: ((command: string, tab?: chrome.tabs.Tab) => void) | undefined;
    stubChrome(itemWith([]), []);
    vi.stubGlobal('chrome', {
      ...globalThis.chrome,
      commands: { onCommand: { addListener: (listener: typeof onCommand) => { onCommand = listener; } } },
    });
    await import('../src/background/service-worker');

    // 场景一：模板变量缺失 → 不发 APPLY_FIELDS，提示去侧栏预览填写。
    stubChrome(
      itemWith([{ key: 'name:note', name: 'note', type: 'text', value: 'Hello {{person}}' }]),
      [{ key: 'name:note', name: 'note', type: 'text', value: '' }],
    );
    onCommand!(COMMANDS.paste, { id: 7 } as chrome.tabs.Tab);
    await wait(30);
    {
      const toasts = stubbedToasts();
      expect(toasts.some((toast) => toast.includes('缺少变量：person'))).toBe(true);
      expect(toasts.some((toast) => toast.includes('请在侧栏预览并填写'))).toBe(true);
      expect(applies()).toHaveLength(0);
    }

    await wait(320); // 快捷键去重窗口

    // 场景二：目标有表单但没有变量问题、全部字段被跳过 → 说明最主要的跳过原因。
    stubChrome(
      itemWith([{ key: 'name:choose', name: 'choose', type: 'select', value: null }]),
      [{ key: 'name:choose', name: 'choose', type: 'select', value: 'x' }],
    );
    onCommand!(COMMANDS.paste, { id: 7 } as chrome.tabs.Tab);
    await wait(30);
    expect(stubbedToasts().some((toast) => toast.includes('没有可填充的字段（跳过 1 个）：源字段未选择，已跳过'))).toBe(true);
    expect(applies()).toHaveLength(0);

    await wait(320);

    // 场景三：变量可解析且字段匹配 → 保持一键填充行为。
    stubChrome(
      itemWith([{ key: 'name:foo', name: 'foo', type: 'text', value: 'bar' }]),
      [{ key: 'name:foo', name: 'foo', type: 'text', value: 'old' }],
    );
    onCommand!(COMMANDS.paste, { id: 7 } as chrome.tabs.Tab);
    await wait(30);
    expect(stubbedToasts().some((toast) => toast.includes('已直接填充'))).toBe(true);
    expect(applies()).toHaveLength(1);

    function stubbedToasts(): string[] {
      const sendMessage = vi.mocked(chrome.tabs.sendMessage);
      return sendMessage.mock.calls
        .filter(([, request]) => (request as { type?: string }).type === 'SHOW_TOAST')
        .map(([, request]) => String((request as { message?: string }).message));
    }
    function applies(): unknown[] {
      const sendMessage = vi.mocked(chrome.tabs.sendMessage);
      return sendMessage.mock.calls.filter(([, request]) => (request as { type?: string }).type === 'APPLY_FIELDS');
    }
  });
});

describe('skip reason summary', () => {
  it('returns the most frequent skip reason', () => {
    expect(topSkipReason([])).toBeUndefined();
    expect(topSkipReason([
      { label: 'a', reason: '原因甲' },
      { label: 'b', reason: '原因乙' },
      { label: 'c', reason: '原因甲' },
    ])).toEqual({ reason: '原因甲', count: 2 });
  });
});
