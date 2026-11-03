import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormScanResult } from '../src/modules/form-clipboard/clipboard-types';
import { scanTab, sendToTab } from '../src/shared/messaging/tab-messaging';

afterEach(() => vi.unstubAllGlobals());

const scan = (url: string, fields: number): FormScanResult => ({
  source: { url, host: new URL(url).host },
  fields: Array.from({ length: fields }, (_, index) => ({
    key: `name:field${index}`, name: `field${index}`, type: 'text', value: String(index),
  })),
});

describe('frame routing', () => {
  it('selects the focused iframe and retains its document identity for filling', async () => {
    const sendMessage = vi.fn(async (_tabId: number, _request: unknown, target: { documentId: string }) =>
      target.documentId === 'child-doc'
        ? { ok: true, scan: scan('https://child.example/form', 2), focused: true }
        : { ok: true, scan: scan('https://main.example/', 1), focused: false });
    vi.stubGlobal('chrome', {
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, documentId: 'main-doc' }, { frameId: 3, documentId: 'child-doc' },
      ]) },
      tabs: { sendMessage },
    });

    const target = await scanTab(7);
    expect(target).toMatchObject({ frameId: 3, documentId: 'child-doc', scan: { source: { url: 'https://child.example/form' } } });
    await sendToTab(7, { type: 'APPLY_FIELDS', assignments: [] }, { documentId: target.documentId });
    expect(sendMessage).toHaveBeenLastCalledWith(7, { type: 'APPLY_FIELDS', assignments: [] }, { documentId: 'child-doc' });
  });

  it('keeps the main form when no frame has a focused field', async () => {
    vi.stubGlobal('chrome', {
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, documentId: 'main-doc' }, { frameId: 1, documentId: 'child-doc' },
      ]) },
      tabs: { sendMessage: vi.fn(async (_tabId: number, _request: unknown, target: { documentId: string }) =>
        ({ ok: true, scan: scan(`https://${target.documentId}.example/`, target.documentId === 'main-doc' ? 1 : 3), focused: false })) },
    });
    expect((await scanTab(7)).frameId).toBe(0);
  });

  it('ignores an inaccessible frame when another frame can be scanned', async () => {
    vi.stubGlobal('chrome', {
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, documentId: 'main-doc' }, { frameId: 2, documentId: 'child-doc' },
      ]) },
      tabs: { sendMessage: vi.fn(async (_tabId: number, _request: unknown, target: { documentId: string }) => {
        if (target.documentId === 'main-doc') throw new Error('No receiver');
        return { ok: true, scan: scan('https://child.example/form', 1), focused: false };
      }) },
    });
    expect((await scanTab(7)).frameId).toBe(2);
  });
});
