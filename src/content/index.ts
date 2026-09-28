import { applyFields } from './apply-fields';
import { listFormCandidates, isFocusedScannedForm, scanForm } from './scanner/form-scanner';
import { scopeElement } from './scanner/scope-registry';
import { registerPageShortcuts } from './shortcut';
import type { ContentRequest, ContentResponse } from '../shared/messaging/messages';

const showToast = (message: string, tone: 'success' | 'error' = 'success'): void => {
  document.getElementById('devpilot-toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'devpilot-toast';
  toast.textContent = message;
  Object.assign(toast.style, {
    position: 'fixed',
    zIndex: '2147483647',
    top: '20px',
    right: '20px',
    maxWidth: '320px',
    padding: '12px 16px',
    borderRadius: '12px',
    color: '#fff',
    background: tone === 'error' ? '#c83f49' : '#202124',
    boxShadow: '0 12px 30px rgba(0,0,0,.2)',
    font: '13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });
  document.documentElement.append(toast);
  window.setTimeout(() => toast.remove(), 3200);
};

const handleRequest = async (request: ContentRequest): Promise<ContentResponse> => {
  try {
    if (request.type === 'SCAN_FORM') {
      if (request.scopeId) {
        const fixed = scopeElement(request.scopeId);
        // 作用域已被页面重渲染替换：要求重新扫描，不能退回自动挑选其他表单。
        if (!fixed || !fixed.isConnected) return { ok: false, error: '目标表单已变化，请重新扫描。' };
        const fixedScan = scanForm(document, undefined, fixed);
        return { ok: true, scan: fixedScan.result, focused: isFocusedScannedForm(fixedScan) };
      }
      const scanned = scanForm();
      return { ok: true, scan: scanned.result, focused: isFocusedScannedForm(scanned) };
    }
    if (request.type === 'LIST_FORM_CANDIDATES') {
      return { ok: true, candidates: listFormCandidates() };
    }
    if (request.type === 'APPLY_FIELDS') {
      return { ok: true, report: await applyFields(request.assignments, request.expectedTarget) };
    }
    showToast(request.message, request.tone);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'DevPilot 操作失败' };
  }
};

chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
  void handleRequest(request).then(sendResponse);
  return true;
});

registerPageShortcuts((message) => showToast(message, 'error'));
