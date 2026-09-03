import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import { ARIA_RADIO_GROUP_SELECTOR, ARIA_RADIO_SELECTOR } from '../scanner/control-selectors';
import type { FormControlElement } from '../scanner/field-filter';
import { dispatchValueEvents, type FieldAdapter } from './field-adapter';

/**
 * 无原生 input 的 ARIA 开关型控件适配器。
 * 覆盖 Radix UI / shadcn/ui 的 Checkbox 与 RadioGroupItem——它们用
 * `role="checkbox"` / `role="radio"` 的 button 表达状态，页面里没有对应的原生 input。
 */

const isChecked = (element: HTMLElement): boolean => {
  const ariaChecked = element.getAttribute('aria-checked');
  if (ariaChecked !== null) {
    return ariaChecked === 'true';
  }
  return element.getAttribute('data-state') === 'checked';
};

const optionValue = (element: HTMLElement): string =>
  element.getAttribute('value') ??
  element.getAttribute('data-value') ??
  element.textContent?.replace(/\s+/g, ' ').trim() ??
  '';

const isNativeControl = (element: FormControlElement): boolean =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLSelectElement ||
  element instanceof HTMLTextAreaElement;

/** 找到 ARIA 单选组内的全部候选项；没有 radiogroup 容器时退化为元素自身。 */
export const findAriaRadioGroup = (element: HTMLElement): HTMLElement[] => {
  const group = element.closest<HTMLElement>(ARIA_RADIO_GROUP_SELECTOR);
  if (group) {
    return [...group.querySelectorAll<HTMLElement>(ARIA_RADIO_SELECTOR)];
  }
  return [element];
};

const applyCheckboxState = (element: HTMLElement, checked: boolean): void => {
  element.setAttribute('aria-checked', String(checked));
  element.setAttribute('data-state', checked ? 'checked' : 'unchecked');
  dispatchValueEvents(element);
};

const applyRadioState = (group: HTMLElement[], target: HTMLElement): void => {
  for (const option of group) {
    const checked = option === target;
    option.setAttribute('aria-checked', String(checked));
    option.setAttribute('data-state', checked ? 'checked' : 'unchecked');
  }
  dispatchValueEvents(target);
};

export class AriaToggleAdapter implements FieldAdapter {
  supports(element: FormControlElement): boolean {
    // 原生控件即使带 role 也交给 Checkbox/Radio 适配器处理，避免两套实现打架。
    if (isNativeControl(element)) {
      return false;
    }
    const role = element.getAttribute('role');
    return role === 'checkbox' || role === 'radio';
  }

  getValue(element: FormControlElement): FormValue {
    if (element.getAttribute('role') === 'radio') {
      const selected = findAriaRadioGroup(element).find(isChecked);
      return selected ? optionValue(selected) : null;
    }
    return isChecked(element);
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    if (element.getAttribute('role') === 'radio') {
      const group = findAriaRadioGroup(element);
      const target = group.find((option) => optionValue(option) === String(value ?? ''));
      if (!target) {
        throw new Error('未找到对应的单选项');
      }
      if (!isChecked(target)) {
        target.click();
      }
      if (!isChecked(target)) {
        applyRadioState(group, target);
      }
      return;
    }

    const checked = Boolean(value);
    if (isChecked(element) !== checked) {
      element.click();
    }
    if (isChecked(element) !== checked) {
      applyCheckboxState(element, checked);
    }
  }
}
