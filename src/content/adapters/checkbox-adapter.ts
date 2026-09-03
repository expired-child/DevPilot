import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import type { FormControlElement } from '../scanner/field-filter';
import { dispatchValueEvents, type FieldAdapter } from './field-adapter';

export class CheckboxAdapter implements FieldAdapter {
  supports(element: FormControlElement): element is HTMLInputElement {
    return element instanceof HTMLInputElement && element.type === 'checkbox';
  }

  getValue(element: FormControlElement): FormValue {
    return (element as HTMLInputElement).checked;
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    const checkbox = element as HTMLInputElement;
    const checked = Boolean(value);
    if (checkbox.checked !== checked) {
      checkbox.click();
    }
    if (checkbox.checked !== checked) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      descriptor?.set?.call(checkbox, checked);
      dispatchValueEvents(checkbox);
    }
  }
}
