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
    let usedNativeInput = false;

    if (text) {
      const selection = typeof document.getSelection === 'function' ? document.getSelection() : null;
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      // ProseMirror/Quill/Tiptap/Lexical 等编辑器只信任浏览器原生的 beforeinput/input 流程，
      // 直接改 innerText 只动了 DOM，编辑器下一次渲染就会覆盖。execCommand('insertText')
      // 会触发原生输入事件，能同步这些编辑器的内部状态。
      usedNativeInput = typeof document.execCommand === 'function' &&
        document.execCommand('insertText', false, text);
      if (!usedNativeInput || element.innerText.replace(/\s+/g, ' ').trim() !== text.replace(/\s+/g, ' ').trim()) {
        usedNativeInput = false;
        element.innerText = text;
      }
    } else {
      element.innerText = '';
    }

    // 原生输入流程已经派发过 input 事件；直接写 DOM 时需要补发，供受控组件同步。
    if (!usedNativeInput) {
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: text,
      }));
    }
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    element.blur();
  }
}
