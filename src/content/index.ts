import { getFieldAdapter } from './adapters';
import { scanForm } from './scanner/form-scanner';
import { registerPageShortcuts } from './shortcut';
import type { FieldAssignment, FillReport, FormValue } from '../modules/form-clipboard/clipboard-types';
import type { ContentRequest, ContentResponse } from '../shared/messaging/messages';

const sameValue = (left: FormValue, right: FormValue): boolean => JSON.stringify(left) === JSON.stringify(right);

const applyFields = async (assignments: FieldAssignment[]): Promise<FillReport> => {
  const { controls } = scanForm();
  const byKey = new Map(controls.map((entry) => [entry.field.key, entry]));
  const report: FillReport = { success: 0, skipped: 0, failed: 0, issues: [] };

  for (const assignment of assignments) {
    const target = byKey.get(assignment.targetKey);
    if (!target) {
      report.skipped += 1;
      report.issues.push({ label: assignment.label, reason: '页面变化后未找到目标字段' });
      continue;
    }
    if (target.field.disabled) {
      report.skipped += 1;
      report.issues.push({ label: assignment.label, reason: '目标字段已禁用' });
      continue;
    }

    const adapter = getFieldAdapter(target.element);
    if (!adapter) {
      report.skipped += 1;
      report.issues.push({ label: assignment.label, reason: '暂不支持该控件' });
      continue;
    }

    try {
      await adapter.setValue(target.element, assignment.value);
      if (!sameValue(adapter.getValue(target.element), assignment.value)) {
        throw new Error('控件未接受新值');
      }
      report.success += 1;
    } catch (error) {
      report.failed += 1;
      report.issues.push({
        label: assignment.label,
        reason: error instanceof Error ? error.message : '填充失败',
      });
    }
  }

  return report;
};

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
      return { ok: true, scan: scanForm().result };
    }
    if (request.type === 'APPLY_FIELDS') {
      return { ok: true, report: await applyFields(request.assignments) };
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
