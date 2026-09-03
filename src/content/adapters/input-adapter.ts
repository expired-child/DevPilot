import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import type { FormControlElement } from '../scanner/field-filter';
import { dispatchValueEvents, setNativeValue, type FieldAdapter } from './field-adapter';
import { readReactValue } from './react-props';

export class InputAdapter implements FieldAdapter {
  supports(element: FormControlElement): element is HTMLInputElement {
    return element instanceof HTMLInputElement && !['checkbox', 'radio'].includes(element.type);
  }

  getValue(element: FormControlElement): FormValue {
    const input = element as HTMLInputElement;
    // 自研受控组件可能只把值存在 React 内部（DOM value 恒为空），此时回退内部值。
    return input.value || readReactValue(element) || '';
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    setNativeValue(element as HTMLInputElement, String(value ?? ''));
    dispatchValueEvents(element);
  }
}
