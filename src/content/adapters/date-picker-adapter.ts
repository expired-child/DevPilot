import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import { DATE_PICKER_ROOT_SELECTOR } from '../scanner/control-selectors';
import type { FormControlElement } from '../scanner/field-filter';
import { dispatchValueEvents, setNativeValue, type FieldAdapter } from './field-adapter';
import { readReactValue } from './react-props';

export const findDatePickerRoot = (element: HTMLElement): HTMLElement | null =>
  element.closest<HTMLElement>(DATE_PICKER_ROOT_SELECTOR);

/**
 * 日期/时间选择控件。它的输入框本身是普通文本输入，
 * 但值必须走「输入 + 确认（回车/失焦）」才能被面板接受，直接赋值不会写入组件状态。
 */
export class DatePickerAdapter implements FieldAdapter {
  supports(element: FormControlElement): element is HTMLInputElement {
    return element instanceof HTMLInputElement && Boolean(findDatePickerRoot(element));
  }

  getValue(element: FormControlElement): FormValue {
    const input = element as HTMLInputElement;
    return input.value || readReactValue(element) || '';
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    const input = element as HTMLInputElement;
    const text = String(value ?? '').trim();
    if (!text) {
      setNativeValue(input, '');
      dispatchValueEvents(input);
      return;
    }

    input.focus?.();
    setNativeValue(input, text);
    dispatchValueEvents(input);
    // AntD/Element 的日期面板以 Enter 确认输入，仅 input/change 事件不会提交给组件。
    for (const type of ['keydown', 'keyup']) {
      input.dispatchEvent(
        new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, composed: true }),
      );
    }
    input.blur?.();
  }
}
