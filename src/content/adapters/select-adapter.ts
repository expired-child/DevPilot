import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import type { FormControlElement } from '../scanner/field-filter';
import { dispatchValueEvents, setNativeValue, type FieldAdapter } from './field-adapter';

export class NativeSelectAdapter implements FieldAdapter {
  supports(element: FormControlElement): element is HTMLSelectElement {
    return element instanceof HTMLSelectElement;
  }

  getValue(element: FormControlElement): FormValue {
    const select = element as HTMLSelectElement;
    return select.multiple ? [...select.selectedOptions].map((option) => option.value) : select.value;
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    const select = element as HTMLSelectElement;
    if (select.multiple) {
      const selected = new Set(Array.isArray(value) ? value : [String(value ?? '')]);
      for (const option of select.options) {
        option.selected = selected.has(option.value);
      }
    } else {
      setNativeValue(select, String(value ?? ''));
    }
    dispatchValueEvents(select);
  }
}
