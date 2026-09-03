import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import type { FormControlElement } from '../scanner/field-filter';
import { dispatchValueEvents, type FieldAdapter } from './field-adapter';

const attributeText = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export class RadioAdapter implements FieldAdapter {
  supports(element: FormControlElement): element is HTMLInputElement {
    return element instanceof HTMLInputElement && element.type === 'radio';
  }

  getValue(element: FormControlElement): FormValue {
    const radio = element as HTMLInputElement;
    const root: ParentNode = radio.form ?? document;
    if (!radio.name) {
      return radio.checked ? radio.value : null;
    }
    return (
      root.querySelector<HTMLInputElement>(
        `input[type="radio"][name="${attributeText(radio.name)}"]:checked`,
      )?.value ?? null
    );
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    const radio = element as HTMLInputElement;
    const root: ParentNode = radio.form ?? document;
    const candidates = radio.name
      ? [...root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${attributeText(radio.name)}"]`)]
      : [radio];
    const target = candidates.find((candidate) => candidate.value === String(value ?? ''));
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
