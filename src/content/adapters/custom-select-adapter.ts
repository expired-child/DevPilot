import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import {
  COMBOBOX_SELECTOR,
  CUSTOM_SELECT_ROOT_SELECTOR,
  DROPDOWN_HIDDEN_SELECTOR,
  DROPDOWN_OPTION_SELECTOR,
  DROPDOWN_POPUP_SELECTOR,
  DROPDOWN_TRIGGER_SELECTOR,
  isMultipleSelect,
  SELECTED_VALUE_SELECTOR,
} from '../scanner/control-selectors';
import type { FormControlElement } from '../scanner/field-filter';
import type { FieldAdapter } from './field-adapter';

const text = (value?: string | null): string => value?.replace(/\s+/g, ' ').trim() ?? '';
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));
export const findCustomSelectRoot = (element: HTMLElement): HTMLElement | null => {
  const frameworkRoot = element.closest<HTMLElement>(CUSTOM_SELECT_ROOT_SELECTOR);
  if (frameworkRoot) {
    return frameworkRoot;
  }

  const combobox = element.matches(COMBOBOX_SELECTOR) ? element : element.closest<HTMLElement>(COMBOBOX_SELECTOR);
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
      [...root.querySelectorAll<HTMLElement>(SELECTED_VALUE_SELECTOR)]
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
    rootElement.matches(`${COMBOBOX_SELECTOR}, .MuiSelect-select`)
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
  [...document.querySelectorAll<HTMLElement>(DROPDOWN_OPTION_SELECTOR)].filter((option) => {
    const style = getComputedStyle(option);
    const popup = option.closest<HTMLElement>(DROPDOWN_POPUP_SELECTOR);
    const popupStyle = popup ? getComputedStyle(popup) : null;
    return (
      !option.closest(DROPDOWN_HIDDEN_SELECTOR) &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      popupStyle?.display !== 'none' &&
      popupStyle?.visibility !== 'hidden' &&
      option.getClientRects().length > 0
    );
  });

const clickOption = (option: HTMLElement): void => {
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
  option.click();
};

/** 在触发区上模拟一次用户点击：展开与收起都是它（toggle 行为）。 */
const toggleSelect = (root: HTMLElement, element: FormControlElement): void => {
  const trigger = root.querySelector<HTMLElement>(DROPDOWN_TRIGGER_SELECTOR) ?? element;
  trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
  trigger.click();
};

const openSelect = toggleSelect;

/**
 * 多选下拉点击选项后通常不会自动收起，需要补一次 trigger 点击（toggle 收起）。
 * 注意：不要派发 Escape/focusout 等合成事件——它们会冒泡到 document，
 * 被弹窗组件（AntD Modal / Element Dialog 等）的键盘监听误消费，导致表单弹窗被关闭。
 */
const closeSelect = toggleSelect;

export class CustomSelectAdapter implements FieldAdapter {
  supports(element: FormControlElement): boolean {
    return !(element instanceof HTMLSelectElement) && Boolean(findCustomSelectRoot(element));
  }

  getValue(element: FormControlElement): FormValue {
    const root = findCustomSelectRoot(element) ?? element;
    const selected = readSelectedText(root);
    const value = selected === '' && element instanceof HTMLInputElement ? element.value : selected;
    if (isMultipleSelect(root) && !Array.isArray(value)) {
      return value === '' || value === null ? [] : [String(value)];
    }
    return value;
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    const root = findCustomSelectRoot(element);
    if (!root) {
      throw new Error('未找到下拉框容器');
    }

    const values = (Array.isArray(value) ? value : [value])
      .map((entry) => String(entry ?? '').trim())
      .filter(Boolean);
    if (values.length === 0) {
      throw new Error('未获取到要填充的下拉值');
    }

    // 已选中的项不重复点击，保证重复粘贴同一份数据时幂等。
    const current = this.getValue(element);
    const selected = new Set(Array.isArray(current) ? current.map(String) : [String(current ?? '')]);

    openSelect(root, element);
    const missing: string[] = [];
    for (const target of values) {
      if (selected.has(target)) {
        continue;
      }
      let option: HTMLElement | undefined;
      for (let attempt = 0; attempt < 20 && !option; attempt += 1) {
        await wait(50);
        option = findMatchingOption(visibleOptions(), target);
      }
      if (!option) {
        missing.push(target);
        continue;
      }
      clickOption(option);
      await wait(80);
    }
    // 单选点击选项后框架会自动收起；多选需要手动 toggle 收起。
    if (isMultipleSelect(root)) {
      closeSelect(root, element);
      await wait(80);
    }

    if (missing.length > 0) {
      throw new Error(`未找到下拉选项：${missing.join('、')}`);
    }
  }
}
