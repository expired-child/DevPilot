import type { ContentRequest, ContentResponse, FormCandidateSummary } from './messages';
import type { FormScanResult } from '../../modules/form-clipboard/clipboard-types';

export interface ScannedTab {
  scan: FormScanResult;
  frameId: number;
  documentId?: string;
}

export interface FrameScan extends ScannedTab {
  focused: boolean;
}

export interface CandidateOption extends FormCandidateSummary {
  frameId: number;
  documentId?: string;
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

/** 汇总各 frame 的候选表单；不可达 frame（如 Chrome 内置页）静默跳过。 */
export const listFormCandidates = async (tabId: number): Promise<CandidateOption[]> => {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }))
    ?.sort((left, right) => left.frameId - right.frameId) ?? [];
  const targets = frames.length ? frames : [{ frameId: 0, documentId: undefined }];
  const replies = await Promise.allSettled(targets.map(async ({ frameId, documentId }): Promise<CandidateOption[]> => {
    const response = await sendToTab(tabId, { type: 'LIST_FORM_CANDIDATES' }, documentId ? { documentId } : { frameId });
    if (!response?.ok || !('candidates' in response)) {
      throw new Error(response && 'error' in response ? response.error : '当前页面暂不支持表单扫描');
    }
    return response.candidates.map((candidate) => ({ ...candidate, frameId, documentId }));
  }));
  return replies.flatMap((reply) => reply.status === 'fulfilled' ? reply.value : []);
};

/** 快捷键/右键菜单的唯一目标：总数唯一，或焦点、弹窗恰好唯一确定一个候选。 */
export const uniqueCandidate = (options: CandidateOption[]): CandidateOption | undefined => {
  if (options.length === 1) return options[0];
  const focused = options.filter((option) => option.focused);
  if (focused.length === 1) return focused[0];
  const dialogs = options.filter((option) => option.dialog);
  if (dialogs.length === 1) return dialogs[0];
  return undefined;
};

/** 侧栏候选列表的推荐项：焦点 > 弹窗 > 主 frame > 字段最多。 */
export const recommendedCandidate = (options: CandidateOption[]): CandidateOption | undefined => {
  const rank = (option: CandidateOption): number => (option.focused ? 0 : option.dialog ? 1 : option.frameId === 0 ? 2 : 3);
  return [...options].sort((left, right) => rank(left) - rank(right) || right.fieldCount - left.fieldCount)[0];
};

/** 重新扫描用户选中的作用域，并验证候选仍然存在。 */
export const scanScope = async (
  tabId: number,
  option: { scopeId: string; frameId: number; documentId?: string },
): Promise<ScannedTab> => {
  const response = await sendToTab(
    tabId,
    { type: 'SCAN_FORM', scopeId: option.scopeId },
    option.documentId ? { documentId: option.documentId } : { frameId: option.frameId },
  );
  if (!response?.ok || !('scan' in response)) {
    throw new Error(response && 'error' in response ? response.error : '目标表单已变化，请重新选择目标表单。');
  }
  if (response.scan.scopeId !== option.scopeId || response.scan.fields.length === 0) {
    throw new Error('目标表单已变化，请重新选择目标表单。');
  }
  return { scan: response.scan, frameId: option.frameId, documentId: option.documentId };
};
