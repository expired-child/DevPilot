import type { ContentRequest, ContentResponse } from './messages';
import type { FormScanResult } from '../../modules/form-clipboard/clipboard-types';

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
): Promise<ContentResponse> => chrome.tabs.sendMessage(tabId, request) as Promise<ContentResponse>;

export const scanActiveTab = async (): Promise<FormScanResult> => {
  const tab = await getActiveTab();
  const response = await sendToTab(tab.id!, { type: 'SCAN_FORM' });
  if (!response?.ok || !('scan' in response)) {
    throw new Error(response && 'error' in response ? response.error : '当前页面暂不支持表单扫描');
  }
  return response.scan;
};
