import { applyFields } from './apply-fields';
import { listFormCandidates, isFocusedScannedForm, scanForm } from './scanner/form-scanner';
import { scopeElement } from './scanner/scope-registry';
import { registerPageShortcuts } from './shortcut';
import { registerFilePreview } from './file-preview';
import { webUrl, type BookClipAction, type BookClipResult } from '../modules/book-clip/types';
import type { ContentRequest, ContentResponse } from '../shared/messaging/messages';

let filling = false;
let bookImages: { pageUrl: string; urls: Set<string> } | undefined;

async function handleBookClip(request: BookClipAction): Promise<BookClipResult> {
  const current = webUrl(location.href);
  if (window !== window.top || !current || (request.action !== 'scan' && request.origin !== current.origin)) {
    throw new Error('网页已切换或不是普通网页，请重新扫描。');
  }
  if (request.action === 'image') {
    if (bookImages?.pageUrl !== current.href || request.pageUrl !== current.href || !bookImages.urls.has(request.url)) {
      throw new Error('图片不属于刚采集的页面');
    }
    const { readBookImage } = await import('./book-clip-image');
    return { image: await readBookImage(request.url) };
  }
  const { scanBook, readBookPage, jumpBookChapter } = await import('./book-clip');
  if (request.action === 'scan') {
    const scan = await scanBook(document, current.href);
    if (location.href !== current.href) throw new Error('扫描期间已切换网页，请重新扫描。');
    return { scan };
  }
  if (request.action === 'jump') return { jumped: jumpBookChapter(request.chapter) };
  const page = readBookPage();
  bookImages = { pageUrl: page.url, urls: new Set(page.images.map(({ url }) => url)) };
  return { page };
}

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

const handleRequest = async (request: Exclude<ContentRequest, { type: 'BOOK_CLIP' }>): Promise<ContentResponse> => {
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
      if (filling) return { ok: false, error: '当前页面正在填充，请等待完成。' };
      filling = true;
      try {
        return { ok: true, report: await applyFields(request.assignments, request.expectedTarget) };
      } finally {
        filling = false;
      }
    }
    showToast(request.message, request.tone);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'DevPilot 操作失败' };
  }
};

chrome.runtime.onMessage.addListener((request: ContentRequest, sender, sendResponse) => {
  if (request.type === 'BOOK_CLIP') {
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('sidepanel.html')) return false;
    void handleBookClip(request).then(
      book => sendResponse({ ok: true, book }),
      error => sendResponse({ ok: false, error: error instanceof Error ? error.message : '无法采集网页' }),
    );
    return true;
  }
  void handleRequest(request).then(sendResponse);
  return true;
});

registerPageShortcuts((message) => showToast(message, 'error'));
registerFilePreview();
