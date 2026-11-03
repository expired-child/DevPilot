import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import type { FormControlElement } from '../scanner/field-filter';
import { closestComposed, querySelectorAllDeep } from '../scanner/composed-dom';
import { dispatchValueEvents, type FieldAdapter } from './field-adapter';

const attributeText = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * 单选项的稳定标识：有 value 属性时用它；手写表单常省略 value（此时浏览器把值统一视为 "on"），
 * 只能用可见标签区分，否则复制后无法知道用户选的是哪一项。
 */
const radioValue = (radio: HTMLInputElement): string => {
  if (radio.hasAttribute('value')) {
    return radio.value;
  }
  const labelText = [...(radio.labels ?? [])]
    .map((label) => label.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(Boolean)
    .join(' ');
  if (labelText) {
    return labelText;
  }
  const wrapping = closestComposed<HTMLLabelElement>(radio, 'label');
  const text = wrapping?.textContent?.replace(/\s+/g, ' ').trim();
  return text || radio.getAttribute('aria-label')?.trim() || radio.value;
};

const radioCandidates = (radio: HTMLInputElement): HTMLInputElement[] => {
  if (!radio.name) return [radio];
  const selector = `input[type="radio"][name="${attributeText(radio.name)}"]`;
  const root = radio.getRootNode();
  const form = closestComposed<HTMLFormElement>(radio, 'form');
  if (root instanceof ShadowRoot && (!form || form.getRootNode() !== root)) {
    return [...root.querySelectorAll<HTMLInputElement>(selector)];
  }
  if (form) return querySelectorAllDeep<HTMLInputElement>(form, selector);
  return root instanceof Document || root instanceof ShadowRoot
    ? [...root.querySelectorAll<HTMLInputElement>(selector)] : [radio];
};

export class RadioAdapter implements FieldAdapter {
  supports(element: FormControlElement): element is HTMLInputElement {
    return element instanceof HTMLInputElement && element.type === 'radio';
  }

  getValue(element: FormControlElement): FormValue {
    const radio = element as HTMLInputElement;
    const checked = radioCandidates(radio).find((candidate) => candidate.checked);
    return checked ? radioValue(checked) : null;
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    const radio = element as HTMLInputElement;
    const candidates = radioCandidates(radio);
    const targetValue = String(value ?? '');
    const matches = candidates.filter((candidate) => radioValue(candidate) === targetValue);
    if (matches.length > 1) {
      throw new Error('单选项值不唯一，无法确定目标');
    }
    const target = matches[0];
    if (!target) {
      throw new Error('未找到对应的单选项');
    }
    if (!target.checked) {
      target.click();
    }
    if (!target.checked) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      descriptor?.set?.call(target, true);
      dispatchValueEvents(target);
    }
  }
}
