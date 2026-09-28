import type { ContentRequest, ContentResponse } from './messages';
import type { FormScanResult } from '../../modules/form-clipboard/clipboard-types';

export interface ScannedTab {
  scan: FormScanResult;
  frameId: number;
  documentId?: string;
}

export interface FrameScan extends ScannedTab {
  focused: boolean;
}

export const getActiveTab = async (): Promise<chrome.tabs.Tab> => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('未找到当前标签页');
  }
  return tab;
};

export const sendToTab = async (
  tabId: number,
  request: ContentRequest,
  target: chrome.tabs.MessageSendOptions = { frameId: 0 },
): Promise<ContentResponse> => chrome.tabs.sendMessage(tabId, request, target) as Promise<ContentResponse>;

/** 聚焦字段优先；否则维持顶层表单优先，再选字段最多的子 frame。 */
export const chooseFrameScan = (scans: FrameScan[]): ScannedTab | undefined => {
  const populated = scans.filter(({ scan }) => scan.fields.length > 0);
  const chosen = populated.find(({ focused }) => focused) ??
    populated.find(({ frameId }) => frameId === 0) ??
    populated.reduce<FrameScan | undefined>((best, current) =>
      !best || current.scan.fields.length > best.scan.fields.length ? current : best, undefined) ??
    scans.find(({ frameId }) => frameId === 0) ?? scans[0];
  return chosen && { scan: chosen.scan, frameId: chosen.frameId, documentId: chosen.documentId };
};

export const scanTab = async (tabId: number): Promise<ScannedTab> => {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }))
    ?.sort((left, right) => left.frameId - right.frameId) ?? [];
  const targets = frames.length ? frames : [{ frameId: 0, documentId: undefined }];
  const replies = await Promise.allSettled(targets.map(async ({ frameId, documentId }): Promise<FrameScan> => {
    const response = await sendToTab(tabId, { type: 'SCAN_FORM' }, documentId ? { documentId } : { frameId });
    if (!response?.ok || !('scan' in response)) {
      throw new Error(response && 'error' in response ? response.error : '当前页面暂不支持表单扫描');
    }
    return { scan: response.scan, focused: response.focused, frameId, documentId };
  }));
  const scanned = chooseFrameScan(replies.flatMap((reply) => reply.status === 'fulfilled' ? [reply.value] : []));
  if (scanned) return scanned;
  const error = replies.find((reply) => reply.status === 'rejected');
  throw error?.status === 'rejected' && error.reason instanceof Error
    ? error.reason : new Error('当前页面暂不支持表单扫描');
};

export const scanActiveTab = async (): Promise<ScannedTab> => {
  const tab = await getActiveTab();
  return scanTab(tab.id!);
};
