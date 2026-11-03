import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyFields } from '../src/content/apply-fields';
import { scanForm } from '../src/content/scanner/form-scanner';
import { buildFillPlan } from '../src/modules/form-clipboard/fill-plan-service';
import { ClipboardService } from '../src/modules/form-clipboard/clipboard-service';
import { defaultClipboardState, type ClipboardRepository } from '../src/modules/form-clipboard/clipboard-repository';
import { createFingerprint } from '../src/modules/form-clipboard/fingerprint';
import type { FormClipboardItem, FormClipboardState } from '../src/modules/form-clipboard/clipboard-types';
import { ClipboardDetailPage } from '../src/sidepanel/pages/ClipboardDetailPage';
import { PastePreviewPage } from '../src/sidepanel/pages/PastePreviewPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

const capture = (): FormClipboardItem => ({
  ...scanForm().result,
  id: 'preview', name: '测试表单', createdAt: 0, updatedAt: 0, fingerprint: 'preview',
});

const replacementProps = {
  settings: defaultClipboardState().settings,
  replacementPending: false,
  onReplacementToggle: async () => {},
};

const changeText = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('paste preview', () => {
  it('applies global and field rules to the displayed value and actual fill', async () => {
    document.body.innerHTML = '<form><input name="url" value="https://hsmsh5.demo.ehi.com.cn/resumeDetail"></form>';
    const item = capture();
    item.fields[0].replacementRules = [{ mode: 'text', search: 'resumeDetail', replacement: 'profile' }];
    document.querySelector<HTMLInputElement>('input')!.value = '';
    const target = scanForm().result;
    const settings = { ...defaultClipboardState().settings, replacementEnabled: true };
    const plan = buildFillPlan(item, target.fields, { settings });
    expect(plan.assignments[0].value).toBe('https://hsmsh5.1hai.cn/profile');
    expect(buildFillPlan(item, target.fields, { settings: { ...settings, replacementEnabled: false } }).assignments[0].value)
      .toBe('https://hsmsh5.demo.ehi.com.cn/resumeDetail');

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(PastePreviewPage, {
      ...replacementProps, settings, item, targetFields: target.fields,
      onBack: () => {}, onRefresh: async () => {},
      onConfirm: async () => ({ success: 1, skipped: 0, failed: 0, issues: [] }),
    })); });
    expect(container.textContent).toContain('https://hsmsh5.1hai.cn/profile');
    await act(async () => { root.unmount(); });

    await applyFields(plan.assignments, {
      url: target.source.url,
      fingerprint: createFingerprint(target.source.host, target.fields),
    });
    expect(document.querySelector<HTMLInputElement>('form input')!.value).toBe('https://hsmsh5.1hai.cn/profile');
  });

  it('shows a target value being replaced even when the copied value is unchanged', () => {
    document.body.innerHTML = '<form><input name="name" value="copied"></form>';
    const item = capture();
    document.querySelector<HTMLInputElement>('input')!.value = 'existing';

    const plan = buildFillPlan(item, scanForm().result.fields);
    expect(plan.diffs[0]).toMatchObject({
      status: 'CHANGED', originalValue: 'copied', nextValue: 'copied',
      target: { value: 'existing' },
    });
    expect(plan.assignments).toMatchObject([{ value: 'copied' }]);
  });

  it('rejects a stale preview before changing a field', async () => {
    document.body.innerHTML = '<form><input name="name" value="existing"></form>';
    const scan = scanForm().result;
    const expectedTarget = {
      url: scan.source.url,
      fingerprint: createFingerprint(scan.source.host, scan.fields),
    };
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.value = 'changed after preview';

    await expect(applyFields([{ targetKey: scan.fields[0].key, label: 'name', value: 'copied' }], expectedTarget))
      .rejects.toThrow('目标页面或表单已变化');
    expect(input.value).toBe('changed after preview');
  });

  it('renders saved text values in the detail editor', async () => {
    document.body.innerHTML = '<form><input name="name" value="saved value"></form>';
    const item = capture();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(ClipboardDetailPage, {
      item,
      onBack: () => {}, onPaste: async () => {}, onSave: async () => {}, onDelete: async () => {},
    })); });
    expect(container.querySelector('textarea')?.value).toBe('saved value');
    await act(async () => { root.unmount(); });
  });

  it('shows the target value and sends a rapid double click only once', async () => {
    document.body.innerHTML = '<form><input name="name" value="copied"></form>';
    const item = capture();
    document.querySelector<HTMLInputElement>('input')!.value = 'existing';
    const targetFields = scanForm().result.fields;
    const onConfirm = vi.fn(async () => ({ success: 1, skipped: 0, failed: 0, issues: [] }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(PastePreviewPage, {
      ...replacementProps, item, targetFields, targetTitle: '测试页面', onBack: () => {}, onRefresh: async () => {}, onConfirm,
    })); });

    expect(container.textContent).toContain('目标当前值');
    expect(container.textContent).toContain('existing');
    expect(container.textContent).toContain('值将改变');
    const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('确认填充'))!;
    await act(async () => { button.click(); button.click(); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('填充完成');
    await act(async () => { root.unmount(); });
  });

  it('keeps only fields required by the target page when requested', async () => {
    document.body.innerHTML = '<form><input name="first" value="A"><input name="second" value="B"></form>';
    const item = capture();
    const targetFields = item.fields.map((field) => ({ ...field, required: field.name === 'first', value: '' }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(PastePreviewPage, {
      ...replacementProps, item, targetFields, onBack: () => {}, onRefresh: async () => {}, onConfirm: async () => ({ success: 1, skipped: 1, failed: 0, issues: [] }),
    })); });

    const requiredOnly = [...container.querySelectorAll('button')].find((entry) => entry.textContent === '只填目标页必填')!;
    await act(async () => { requiredOnly.click(); });
    expect(container.textContent).toContain('确认填充（1 个字段）');
    await act(async () => { root.unmount(); });
  });

  it('keeps entered variables when the current page is rescanned', async () => {
    document.body.innerHTML = '<form><input name="message" value="Hello {{person}}"></form>';
    const item = capture();
    const initial = [{ ...item.fields[0], value: '' }];
    function PreviewHarness() {
      const [targetFields, setTargetFields] = useState(initial);
      return createElement(PastePreviewPage, {
        ...replacementProps, item, targetFields, onBack: () => {},
        onRefresh: async () => { setTargetFields([{ ...item.fields[0], value: 'old value' }]); },
        onConfirm: async () => ({ success: 1, skipped: 0, failed: 0, issues: [] }),
      });
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(PreviewHarness)); });

    const variable = container.querySelector<HTMLInputElement>('input[placeholder="输入 person"]')!;
    await act(async () => { changeText(variable, 'Alice'); });
    const refresh = [...container.querySelectorAll('button')].find((entry) => entry.textContent === '重新扫描当前页')!;
    await act(async () => { refresh.click(); });
    expect(container.querySelector<HTMLInputElement>('input[placeholder="输入 person"]')!.value).toBe('Alice');
    expect(container.textContent).toContain('old value');
    expect(container.textContent).toContain('Hello Alice');
    await act(async () => { root.unmount(); });
  });

  it('requires a refresh after a stale target error before confirming again', async () => {
    document.body.innerHTML = '<form><input name="name" value="copied"></form>';
    const item = capture();
    const targetFields = [{ ...item.fields[0], value: 'existing' }];
    const onRefresh = vi.fn(async () => {});
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(PastePreviewPage, {
      ...replacementProps, item, targetFields, onBack: () => {}, onRefresh,
      onConfirm: async () => { throw new Error('目标页面或表单已变化'); },
    })); });

    const confirm = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('确认填充'))!;
    await act(async () => { confirm.click(); });
    expect(container.textContent).toContain('目标页面或表单已变化');
    expect(confirm.disabled).toBe(true);

    const refresh = [...container.querySelectorAll('button')].find((entry) => entry.textContent === '重新扫描当前页')!;
    await act(async () => { refresh.click(); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(confirm.disabled).toBe(false);
    await act(async () => { root.unmount(); });
  });
});

describe('detail changes', () => {
  it('saves a field replacement rule before opening the paste preview', async () => {
    document.body.innerHTML = '<form><input name="name" value="original"></form>';
    const item = capture();
    item.fields[0].replacementRules = [{ mode: 'text', search: 'old', replacement: 'new' }];
    const onSave = vi.fn(async () => {});
    const onPaste = vi.fn(async () => {});
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(ClipboardDetailPage, {
      item, onBack: () => {}, onPaste, onSave, onDelete: async () => {},
    })); });

    await act(async () => { container.querySelector<HTMLElement>('.replacement-editor summary')!.click(); });
    await act(async () => { changeText(container.querySelector<HTMLTextAreaElement>('.replacement-rule textarea[placeholder="a"]')!, 'original'); });
    const paste = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('保存并预览填充'))!;
    await act(async () => { paste.click(); });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      fields: [expect.objectContaining({ replacementRules: [{ mode: 'text', search: 'original', replacement: 'new' }] })],
    }));
    expect(onPaste).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
  });

  it('saves edited values before opening the paste preview', async () => {
    document.body.innerHTML = '<form><input name="name" value="original"></form>';
    const item = capture();
    const events: string[] = [];
    const onSave = vi.fn(async () => { events.push('save'); });
    const onPaste = vi.fn(async () => { events.push('paste'); });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(ClipboardDetailPage, {
      item, onBack: () => {}, onPaste, onSave, onDelete: async () => {},
    })); });

    await act(async () => { changeText(container.querySelector('textarea')!, 'edited'); });
    const paste = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('保存并预览填充'))!;
    await act(async () => { paste.click(); });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fields: [expect.objectContaining({ value: 'edited' })] }));
    expect(events).toEqual(['save', 'paste']);
    await act(async () => { root.unmount(); });
  });

  it('stores detail fields and unique-field rules together', async () => {
    document.body.innerHTML = '<form><input name="name" value="original"></form>';
    const item = capture();
    let state: FormClipboardState = { ...defaultClipboardState(), currentId: item.id, history: [item] };
    const repository: ClipboardRepository = {
      get: async () => structuredClone(state),
      save: async (next) => { state = structuredClone(next); },
    };
    const service = new ClipboardService(repository, () => 123);
    await service.saveDetails(item.id, {
      name: '改名', fields: [{ ...item.fields[0], value: 'edited', replacementRules: [{ mode: 'text', search: 'edited', replacement: 'final' }] }],
      uniqueFieldKeys: [item.fields[0].key], excludedFieldKeys: [], pinned: true,
    });

    expect(state.history[0]).toMatchObject({ name: '改名', pinned: true, updatedAt: 123, fields: [{ value: 'edited' }] });
    expect(state.history[0].fields[0].replacementRules).toEqual([{ mode: 'text', search: 'edited', replacement: 'final' }]);
    expect(state.fieldRules[`${item.source.host}::${item.fields[0].key}`]).toEqual({ unique: true });

    await expect(service.saveDetails(item.id, {
      name: '无效规则', fields: [{ ...item.fields[0], replacementRules: [{ mode: 'regex', search: '[', replacement: '' }] }],
      uniqueFieldKeys: [], excludedFieldKeys: [], pinned: false,
    })).rejects.toThrow('正则表达式无效');
    expect(state.history[0].name).toBe('改名');
  });

  it('keeps an unsaved draft when leaving is cancelled', async () => {
    document.body.innerHTML = '<form><input name="name" value="original"></form>';
    const item = capture();
    const onBack = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(ClipboardDetailPage, {
      item, onBack, onPaste: async () => {}, onSave: async () => {}, onDelete: async () => {},
    })); });

    await act(async () => { changeText(container.querySelector('textarea')!, 'draft'); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="返回表单历史"]')!.click(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('draft');
    await act(async () => { root.unmount(); });
    confirm.mockRestore();
  });

  it('shows a preview scan failure next to the detail action', async () => {
    document.body.innerHTML = '<form><input name="name" value="original"></form>';
    const item = capture();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(ClipboardDetailPage, {
      item, onBack: () => {}, onPaste: async () => { throw new Error('当前页面没有可填充的表单字段'); },
      onSave: async () => {}, onDelete: async () => {},
    })); });

    const paste = [...container.querySelectorAll('button')].find((entry) => entry.textContent === '预览并填充此表单')!;
    await act(async () => { paste.click(); });
    expect(container.querySelector('.sticky-actions [role="alert"]')?.textContent).toContain('当前页面没有可填充的表单字段');
    await act(async () => { root.unmount(); });
  });
});
