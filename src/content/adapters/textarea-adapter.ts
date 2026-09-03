import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import type { FormControlElement } from '../scanner/field-filter';
import { dispatchValueEvents, setNativeValue, type FieldAdapter } from './field-adapter';

export class TextareaAdapter implements FieldAdapter {
  supports(element: FormControlElement): element is HTMLTextAreaElement {
    return element instanceof HTMLTextAreaElement;
  }

  getValue(element: FormControlElement): FormValue {
    return (element as HTMLTextAreaElement).value;
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    setNativeValue(element as HTMLTextAreaElement, String(value ?? ''));
    dispatchValueEvents(element);
  }
}
