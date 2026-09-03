import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import { SWITCH_ROOT_SELECTOR } from '../scanner/control-selectors';
import type { FormControlElement } from '../scanner/field-filter';
import { dispatchValueEvents, type FieldAdapter } from './field-adapter';

export const findSwitchRoot = (element: HTMLElement): HTMLElement | null =>
  element.closest<HTMLElement>(SWITCH_ROOT_SELECTOR);

const hasCheckedClass = (root: HTMLElement): boolean =>
  [...root.classList].some(
    (token) => token === 'checked' || token === 'is-checked' || token.endsWith('-checked') || token === 'n-switch--active',
  );

export const readSwitchChecked = (root: HTMLElement): boolean => {
  const ariaChecked = root.getAttribute('aria-checked');
  if (ariaChecked === 'true') return true;
  if (ariaChecked === 'false') return false;
  if (hasCheckedClass(root)) return true;
  const input = switchInput(root);
  return input ? input.checked : false;
};

const switchInput = (root: HTMLElement): HTMLInputElement | null =>
  root instanceof HTMLInputElement && root.type === 'checkbox'
    ? root
    : root.querySelector<HTMLInputElement>('input[type="checkbox"]');

export class SwitchAdapter implements FieldAdapter {
  supports(element: FormControlElement): boolean {
    if (element instanceof HTMLInputElement && element.type === 'radio') {
      return false;
    }
    return Boolean(findSwitchRoot(element));
  }

  getValue(element: FormControlElement): FormValue {
    return readSwitchChecked(findSwitchRoot(element) ?? element);
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    const root = findSwitchRoot(element) ?? element;
    const checked = Boolean(value);

    if (readSwitchChecked(root) !== checked) {
      const target = element instanceof HTMLInputElement && element.type === 'checkbox' ? element : root;
      target.click();
    }
    if (readSwitchChecked(root) !== checked) {
      const input = switchInput(root);
      if (input) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
        descriptor?.set?.call(input, checked);
        dispatchValueEvents(input);
      }
    }
    if (readSwitchChecked(root) !== checked) {
      throw new Error('开关控件未接受新值');
    }
  }
}
