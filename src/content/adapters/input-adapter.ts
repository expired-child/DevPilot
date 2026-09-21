import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import type { FormControlElement } from '../scanner/field-filter';
import { dispatchValueEvents, setNativeValue, type FieldAdapter } from './field-adapter';

export class InputAdapter implements FieldAdapter {
  supports(element: FormControlElement): element is HTMLInputElement {
    return element instanceof HTMLInputElement && !['checkbox', 'radio'].includes(element.type);
  }

  getValue(element: FormControlElement): FormValue {
    const input = element as HTMLInputElement;
    // 空字符串也是有效的当前值，不能回退到 React 的旧 defaultValue。
    return input.value;
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    setNativeValue(element as HTMLInputElement, String(value ?? ''));
    dispatchValueEvents(element);
  }
}
