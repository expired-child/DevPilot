import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import type { FormControlElement } from '../scanner/field-filter';

export interface FillContext {
  /** 源下拉的底层真实值（如工号/字典编码）；远程搜索时优先用它作为检索词。 */
  searchKey?: string;
}

export interface FieldAdapter {
  supports(element: FormControlElement): boolean;
  getValue(element: FormControlElement): FormValue;
  setValue(element: FormControlElement, value: FormValue, context?: FillContext): Promise<void>;
  /**
   * 回读校验：控件显示值可能与源值形态不同（如下拉按编码匹配到改名后的显示文本）。
   * 未实现时沿用字段值的严格比较。
   */
  matchesValue?(current: FormValue, expected: FormValue): boolean;
}

export const setNativeValue = (
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
};

export const dispatchValueEvents = (element: HTMLElement): void => {
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  element.dispatchEvent(new FocusEvent('blur', { bubbles: true, composed: true }));
};
