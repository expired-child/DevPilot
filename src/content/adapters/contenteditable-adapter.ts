import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import { CONTENT_EDITABLE_SELECTOR } from '../scanner/control-selectors';
import type { FormControlElement } from '../scanner/field-filter';
import type { FieldAdapter } from './field-adapter';

/** 普通 contenteditable 文本。复杂编辑器若拒绝合成 input 事件，会由填充回读报告失败。 */
export class ContentEditableAdapter implements FieldAdapter {
  supports(element: FormControlElement): boolean {
    return element.matches(CONTENT_EDITABLE_SELECTOR) && element.isContentEditable;
  }

  getValue(element: FormControlElement): FormValue {
    return element.innerText;
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    const text = String(value ?? '');
    element.focus();
    element.innerText = text;
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: text,
    }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    element.blur();
  }
}
