import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyFields } from '../src/content/apply-fields';
import { listFormCandidates, scanForm } from '../src/content/scanner/form-scanner';
import { scopeElement } from '../src/content/scanner/scope-registry';
import { createFingerprint } from '../src/modules/form-clipboard/fingerprint';
import { defaultClipboardState } from '../src/modules/form-clipboard/clipboard-repository';
import {
  listFormCandidates as collectCandidates,
  recommendedCandidate,
  scanScope,
  uniqueCandidate,
} from '../src/shared/messaging/tab-messaging';
import { COMMANDS } from '../src/shared/constants';
import { FormCandidatesPage } from '../src/sidepanel/pages/FormCandidatesPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const event = { addListener: () => {}, removeListener: () => {} };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('content script form candidates', () => {
  it('keeps one candidate when a dialog wrapper and its inner form hold the same controls', () => {
    document.body.innerHTML = '<main><form><input name="a" value="1"></form></main>' +
      '<div role="dialog"><form><input name="dialogField" value="2"></form></div>';
    const candidates = listFormCandidates();
    const dialogCandidates = candidates.filter((candidate) => candidate.dialog);
    expect(dialogCandidates).toHaveLength(1);
    expect(dialogCandidates[0].fieldCount).toBe(1);
    expect(dialogCandidates[0].focused).toBe(false);
    expect(dialogCandidates[0].source.host).toBe(location.host);
  });

  it('never exposes field values in candidate summaries', () => {
    document.body.innerHTML = '<form><input name="note" value="top-secret-value"></form>';
    const [candidate] = listFormCandidates();
    expect(JSON.stringify(candidate)).not.toContain('top-secret-value');
  });

  it('keeps identical sibling forms as separate candidates with stable scope ids', () => {
    document.body.innerHTML = '<form><input name="foo" value="same"></form><form><input name="foo" value="same"></form>';
    const candidates = listFormCandidates();
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map(({ scopeId }) => scopeId)).size).toBe(2);
    expect(candidates.every((candidate) => candidate.fieldCount === 1)).toBe(true);
  });

  it('does not offer main as a merged candidate for two independent forms', () => {
    document.body.innerHTML = '<main><form><input name="first" value="a"></form><form><input name="second" value="b"></form></main>';
    const candidates = listFormCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates.map(({ fieldCount }) => fieldCount)).toEqual([1, 1]);
    expect(candidates.every(({ scopeId }) => scopeElement(scopeId)?.tagName === 'FORM')).toBe(true);
  });

  it('retains a body-only form when the page has no form container', () => {
    document.body.innerHTML = '<label>备注<input name="note" value="hello"></label>';
    const candidates = listFormCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].fieldCount).toBe(1);
    expect(scopeElement(candidates[0].scopeId)).toBe(document.body);
  });

  it('does not let an unrelated search-only form make a business shortcut ambiguous', () => {
    document.body.innerHTML = '<form><input type="search" name="search"></form><form><input name="customer" value="a"></form>';
    const candidates = listFormCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].fieldLabels).toContain('customer');
  });
});

describe('scope locked filling', () => {
  it('fills only the scope chosen by the user even when both forms look identical', async () => {
    document.body.innerHTML = '<form><input name="foo" value="same"></form><form><input name="foo" value="same"></form>';
    const [first] = listFormCandidates();
    const scan = scanForm(document, undefined, scopeElement(first.scopeId));
    await applyFields(
      [{ targetKey: scan.result.fields[0].key, label: 'foo', value: 'filled-1' }],
      {
        url: scan.result.source.url,
        fingerprint: createFingerprint(scan.result.source.host, scan.result.fields),
        scopeId: first.scopeId,
      },
    );
    const values = [...document.querySelectorAll('input')].map((input) => input.value);
    expect(values).toEqual(['filled-1', 'same']);
  });

  it('rejects the fill when the locked scope has been re-rendered away', async () => {
    document.body.innerHTML = '<form><input name="foo" value="same"></form><form><input name="foo" value="same"></form>';
    const [first] = listFormCandidates();
    const scan = scanForm(document, undefined, scopeElement(first.scopeId));
    // 模拟目标表单被重渲染替换：原容器从文档移除。
    document.querySelectorAll('form')[0].remove();
    await expect(applyFields(
      [{ targetKey: scan.result.fields[0].key, label: 'foo', value: 'filled-1' }],
      {
        url: scan.result.source.url,
        fingerprint: createFingerprint(scan.result.source.host, scan.result.fields),
        scopeId: first.scopeId,
      },
    )).rejects.toThrow('目标表单已变化，请重新扫描后再填充。');
    expect(document.querySelector<HTMLInputElement>('form input')!.value).toBe('same');
  });
});

describe('candidate routing helpers', () => {
  const option = (overrides: Record<string, unknown>) => ({
    scopeId: 'scope-1', title: '表单', fieldCount: 2, fieldLabels: [],
    dialog: false, focused: false, source: { url: 'https://a.example/', host: 'a.example' },
    frameId: 0, ...overrides,
  });

  it('aggregates candidates from reachable frames', async () => {
    vi.stubGlobal('chrome', {
      webNavigation: { getAllFrames: vi.fn(async () => [
        { frameId: 0, documentId: 'main' }, { frameId: 2, documentId: 'child' },
      ]) },
      tabs: { sendMessage: vi.fn(async (_tabId: number, _request: unknown, target: { documentId: string }) =>
        target.documentId === 'child'
          ? { ok: true, candidates: [option({ scopeId: 'scope-child', fieldCount: 3 })] }
          : { ok: true, candidates: [option({})] }) },
    });
    const candidates = await collectCandidates(7);
    expect(candidates.map(({ frameId, scopeId }) => ({ frameId, scopeId }))).toEqual([
      { frameId: 0, scopeId: 'scope-1' },
      { frameId: 2, scopeId: 'scope-child' },
    ]);
  });

  it('requires a unique focus or dialog before hotkeys act', () => {
    const single = option({});
    expect(uniqueCandidate([single])).toEqual(single);
    expect(uniqueCandidate([option({ scopeId: 'a' }), option({ scopeId: 'b' })])).toBeUndefined();
    expect(uniqueCandidate([option({ scopeId: 'a' }), option({ scopeId: 'b', focused: true })])?.scopeId).toBe('b');
    expect(uniqueCandidate([option({ scopeId: 'a' }), option({ scopeId: 'b', dialog: true })])?.scopeId).toBe('b');
    expect(uniqueCandidate([
      option({ scopeId: 'a', focused: true }), option({ scopeId: 'b', focused: true }),
    ])).toBeUndefined();
  });

  it('marks the recommendation by focus, dialog, main frame, then field count', () => {
    const options = [
      option({ scopeId: 'iframe', frameId: 3, fieldCount: 9 }),
      option({ scopeId: 'dialog', dialog: true, frameId: 3 }),
      option({ scopeId: 'main', fieldCount: 1 }),
      option({ scopeId: 'focused', focused: true, frameId: 3 }),
    ];
    expect(recommendedCandidate(options)!.scopeId).toBe('focused');
    expect(recommendedCandidate(options.filter(({ scopeId }) => scopeId !== 'focused'))!.scopeId).toBe('dialog');
  });

  it('marks only one recommended candidate when frame-local scope ids repeat', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(FormCandidatesPage, {
        candidates: [option({ scopeId: 'scope-1', frameId: 0 }), option({ scopeId: 'scope-1', frameId: 2 })],
        title: '选择表单', onSelect: () => {}, onRefresh: () => {}, onBack: () => {},
      }));
    });
    expect(container.querySelectorAll('.recommended-badge')).toHaveLength(1);
    expect(container.textContent).toContain('子 frame 2');
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('re-scans a chosen scope and refuses stale or empty results', async () => {
    const scan = {
      source: { url: 'https://a.example/', host: 'a.example' },
      fields: [{ key: 'name:foo', type: 'text' as const, value: '1' }],
      scopeId: 'scope-9',
    };
    vi.stubGlobal('chrome', {
      webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'main' }] },
      tabs: { sendMessage: vi.fn(async (_tabId: number, request: { type?: string; scopeId?: string }) => {
        if (request.type === 'SCAN_FORM') {
          if (request.scopeId === 'scope-9') return { ok: true, focused: false, scan: structuredClone(scan) };
          if (request.scopeId === 'scope-empty') return { ok: true, focused: false, scan: { ...structuredClone(scan), scopeId: 'scope-empty', fields: [] } };
          return { ok: false, error: '目标表单已变化，请重新扫描。' };
        }
        return { ok: true };
      }) },
    });

    const target = await scanScope(7, { scopeId: 'scope-9', frameId: 0, documentId: 'main' });
    expect(target.scan.scopeId).toBe('scope-9');
    await expect(scanScope(7, { scopeId: 'scope-empty', frameId: 0, documentId: 'main' }))
      .rejects.toThrow('目标表单已变化，请重新选择目标表单。');
    await expect(scanScope(7, { scopeId: 'scope-gone', frameId: 0, documentId: 'main' }))
      .rejects.toThrow('目标表单已变化，请重新扫描。');
  });
});

describe('hotkey copy refuses to guess among multiple forms', () => {
  it('tells the user to focus a form or pick one in the sidepanel', async () => {
    const toasts: string[] = [];
    let commandListener: ((command: string, tab?: chrome.tabs.Tab) => void) | undefined;
    vi.stubGlobal('chrome', {
      commands: { onCommand: { addListener: (listener: typeof commandListener) => { commandListener = listener; } } },
      runtime: { id: 'ext-1', onInstalled: event, onMessage: event },
      contextMenus: { onClicked: event },
      storage: {
        local: { get: async () => ({ formClipboard: defaultClipboardState() }), set: async () => {} },
        session: { set: async () => {}, get: async () => ({}), remove: async () => {} },
        onChanged: event,
      },
      sidePanel: { open: async () => {}, setPanelBehavior: async () => {} },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'main' }] },
      tabs: {
        sendMessage: vi.fn(async (_tabId: number, request: { type?: string }) => {
          if (request.type === 'LIST_FORM_CANDIDATES') {
            return { ok: true, candidates: [
              { scopeId: 'scope-a', title: '表单A', fieldCount: 2, fieldLabels: [], dialog: false, focused: false, source: { url: 'https://a.example/', host: 'a.example' } },
              { scopeId: 'scope-b', title: '表单B', fieldCount: 2, fieldLabels: [], dialog: false, focused: false, source: { url: 'https://a.example/', host: 'a.example' } },
            ] };
          }
          if (request.type === 'SHOW_TOAST') toasts.push(String((request as { message?: string }).message));
          return { ok: true };
        }),
      },
    });
    await import('../src/background/service-worker');
    commandListener!(COMMANDS.copy, { id: 7 } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(toasts.some((toast) => toast.includes('无法确定目标'))).toBe(true));
  });
});

describe('sidepanel candidate flow', () => {
  const setupApp = async () => {
    const commands: Array<Record<string, unknown>> = [];
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'ext-1',
        onInstalled: event,
        onMessage: event,
        sendMessage: vi.fn(async (message: Record<string, unknown>) => {
          commands.push(message);
          return { ok: true, item: { id: 'item-1', name: '表单A', fields: [{}] } };
        }),
      },
      storage: {
        local: { get: async () => ({ formClipboard: structuredClone(defaultClipboardState()) }), set: async () => {} },
        session: { set: async () => {}, get: async () => ({}), remove: async () => {} },
        onChanged: event,
      },
      windows: { getCurrent: async () => ({ id: 42 }) },
      bookmarks: { getTree: async () => [], onCreated: event, onRemoved: event, onChanged: event, onMoved: event },
      sidePanel: { close: async () => {}, open: async () => {}, setPanelBehavior: async () => {} },
      tabs: { query: async () => [{ id: 7 }], create: async () => ({ id: 9, windowId: 42 }) },
      webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'main' }] },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    });
    const sendMessage = vi.fn(async (_tabId: number, request: { type?: string; scopeId?: string }) => {
      if (request.type === 'LIST_FORM_CANDIDATES') {
        return { ok: true, candidates: [
          { scopeId: 'scope-a', title: '表单A', fieldCount: 2, fieldLabels: ['姓名', '电话'], dialog: false, focused: false, source: { url: 'https://a.example/x', host: 'a.example', title: 'A 页' } },
          { scopeId: 'scope-b', title: '表单B', fieldCount: 1, fieldLabels: ['备注'], dialog: false, focused: false, source: { url: 'https://a.example/x', host: 'a.example', title: 'A 页' } },
        ] };
      }
      if (request.type === 'SCAN_FORM') {
        return {
          ok: true, focused: false,
          scan: {
            suggestedName: request.scopeId === 'scope-a' ? '表单A' : '表单B',
            source: { url: 'https://a.example/x', host: 'a.example', title: 'A 页' },
            fields: [{ key: 'name:foo', name: 'foo', type: 'text' as const, value: request.scopeId === 'scope-a' ? 'value-a' : 'value-b' }],
            scopeId: request.scopeId,
          },
        };
      }
      return { ok: true };
    });
    (chrome.tabs as { sendMessage: unknown }).sendMessage = sendMessage;

    const { App } = await import('../src/sidepanel/App');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(App)); });
    await act(async () => { await wait(20); });
    return { container, root, commands, sendMessage };
  };

  it('asks the user to choose when the page has several forms, then captures the chosen one', async () => {
    const { container, root, commands, sendMessage } = await setupApp();

    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === '复制当前表单')!.click();
    });
    expect(container.textContent).toContain('选择要复制的表单');
    expect(container.textContent).toContain('表单A');
    expect(container.textContent).toContain('2 个字段');
    expect(container.textContent).toContain('推荐');
    // 选择前只列出候选，不扫描/填充任何表单。
    expect(sendMessage.mock.calls.some(([, request]) => (request as { type?: string }).type === 'SCAN_FORM')).toBe(false);

    const chooseA = [...container.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label')?.includes('表单A'))!;
    await act(async () => { chooseA.click(); });
    await act(async () => { await wait(20); });

    expect(commands.some((command) => command.type === 'CAPTURE_FORM')).toBe(true);
    expect(container.textContent).toContain('已复制 表单A');
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('re-scans the chosen scope before capturing so the target is confirmed', async () => {
    const { container, root, commands, sendMessage } = await setupApp();

    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === '复制当前表单')!.click();
    });
    commands.length = 0;
    const chooseB = [...container.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label')?.includes('表单B'))!;
    await act(async () => { chooseB.click(); });
    await act(async () => { await wait(20); });

    const scanCalls = sendMessage.mock.calls.filter(([, request]) => (request as { type?: string }).type === 'SCAN_FORM');
    expect(scanCalls.some(([, request]) => (request as { scopeId?: string }).scopeId === 'scope-b')).toBe(true);
    const capture = commands.find((command) => command.type === 'CAPTURE_FORM') as { scan?: { scopeId?: string } } | undefined;
    expect(capture?.scan?.scopeId).toBe('scope-b');
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('does not use an old candidate after the active tab changes', async () => {
    const { container, root, commands } = await setupApp();
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === '复制当前表单')!.click();
    });
    (chrome.tabs as { query: unknown }).query = async () => [{ id: 8 }];
    const chooseA = [...container.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label')?.includes('表单A'))!;
    await act(async () => { chooseA.click(); });
    await act(async () => { await wait(20); });
    expect(commands.some((command) => command.type === 'CAPTURE_FORM')).toBe(false);
    expect(container.textContent).toContain('目标标签页已切换');
    expect(container.textContent).toContain('选择要复制的表单');
    await act(async () => { root.unmount(); });
    container.remove();
  });
});
