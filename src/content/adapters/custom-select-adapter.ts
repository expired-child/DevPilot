import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import type { FormControlElement } from '../scanner/field-filter';
import type { FieldAdapter } from './field-adapter';

const SELECTED_SELECTOR = [
  '.ant-select-selection-selected-value',
  '.ant-select-selection-item',
  '.ant-select-selection__choice__content',
  '.el-select__selected-item',
  '.el-select__tags-text',
  '.MuiSelect-select',
  '.mat-mdc-select-value-text',
  '.mat-select-value-text',
  '.n-base-selection-label__render-label',
  '.arco-select-view-value',
  '.p-dropdown-label',
  '.p-select-label',
  '[class*="singleValue"]',
].join(',');
const OPTION_SELECTOR = [
  '.ant-select-dropdown:not(.ant-select-dropdown-hidden) [role="option"]',
  '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item',
  '.el-select-dropdown:not([style*="display: none"]) .el-select-dropdown__item',
  '.el-popper:not([style*="display: none"]) [role="option"]',
  '[role="listbox"] [role="option"]:not([aria-disabled="true"])',
].join(',');
const CUSTOM_ROOT_SELECTOR = [
  '.ant-select',
  '.el-select',
  '.MuiAutocomplete-root',
  '.MuiSelect-root',
  '.mat-mdc-select',
  '.mat-select',
  '.n-select',
  '.arco-select',
  '.p-dropdown',
  '.p-select',
  '[class*="react-select__control"]',
].join(',');

const text = (value?: string | null): string => value?.replace(/\s+/g, ' ').trim() ?? '';
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));
export const findCustomSelectRoot = (element: HTMLElement): HTMLElement | null => {
  const frameworkRoot = element.closest<HTMLElement>(CUSTOM_ROOT_SELECTOR);
  if (frameworkRoot) {
    return frameworkRoot;
  }

  const combobox = element.matches('[role="combobox"]')
    ? element
    : element.closest<HTMLElement>('[role="combobox"]');
  if (!combobox) {
    return null;
  }

  let current = combobox.parentElement;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
    if (current.querySelector('[class*="singleValue"], [class*="indicatorsContainer"]')) {
      return current;
    }
  }
  return combobox;
};

export const readSelectedText = (root: ParentNode): FormValue => {
  const selected = [
    ...new Set(
      [...root.querySelectorAll<HTMLElement>(SELECTED_SELECTOR)]
        .map((element) => text(element.textContent))
        .filter(Boolean),
    ),
  ];
  if (selected.length > 1) {
    return selected;
  }
  if (selected.length === 1) {
    return selected[0];
  }

  const rootElement = root as HTMLElement;
  if (
    typeof rootElement.matches === 'function' &&
    rootElement.matches('[role="combobox"], .MuiSelect-select')
  ) {
    const ariaValue = rootElement.getAttribute('aria-valuetext');
    if (ariaValue || (!rootElement.querySelector('input') && text(rootElement.textContent))) {
      return ariaValue || text(rootElement.textContent);
    }
  }

  const input = root.querySelector<HTMLInputElement>('input');
  return input?.value ?? '';
};

export const findMatchingOption = (
  options: HTMLElement[],
  value: string,
): HTMLElement | undefined => options.find((option) => text(option.textContent) === text(value));

const visibleOptions = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>(OPTION_SELECTOR)].filter((option) => {
    const style = getComputedStyle(option);
    const popup = option.closest<HTMLElement>(
      '.ant-select-dropdown, .el-select-dropdown, [role="listbox"]',
    );
    const popupStyle = popup ? getComputedStyle(popup) : null;
    return (
      !option.closest('[hidden], .ant-select-dropdown-hidden') &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      popupStyle?.display !== 'none' &&
      popupStyle?.visibility !== 'hidden' &&
      option.getClientRects().length > 0
    );
  });

const openSelect = (root: HTMLElement, element: FormControlElement): void => {
  const trigger =
    root.querySelector<HTMLElement>(
      '.ant-select-selector, .ant-select-selection, .el-input, .MuiSelect-select, .mat-mdc-select-trigger, .mat-select-trigger, [role="combobox"]',
    ) ??
    element;
  trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
  trigger.click();
};

export class CustomSelectAdapter implements FieldAdapter {
  supports(element: FormControlElement): boolean {
    return !(element instanceof HTMLSelectElement) && Boolean(findCustomSelectRoot(element));
  }

  getValue(element: FormControlElement): FormValue {
    const root = findCustomSelectRoot(element) ?? element;
    const selected = readSelectedText(root);
    return selected === '' && element instanceof HTMLInputElement ? element.value : selected;
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    if (Array.isArray(value)) {
      throw new Error('暂不支持多选下拉框');
    }
    const root = findCustomSelectRoot(element);
    if (!root) {
      throw new Error('未找到下拉框容器');
    }

    openSelect(root, element);
    let option: HTMLElement | undefined;
    for (let attempt = 0; attempt < 20 && !option; attempt += 1) {
      await wait(50);
      option = findMatchingOption(visibleOptions(), String(value ?? ''));
    }
    if (!option) {
      throw new Error(`未找到下拉选项：${String(value ?? '')}`);
    }

    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    option.click();
    await wait(80);
  }
}
