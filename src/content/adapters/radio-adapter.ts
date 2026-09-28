import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import type { FormControlElement } from '../scanner/field-filter';
import { closestComposed, querySelectorAllDeep } from '../scanner/composed-dom';
import { dispatchValueEvents, type FieldAdapter } from './field-adapter';

const attributeText = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const radioCandidates = (radio: HTMLInputElement): HTMLInputElement[] => {
  if (!radio.name) return [radio];
  const selector = `input[type="radio"][name="${attributeText(radio.name)}"]`;
  const root = radio.getRootNode();
  const form = closestComposed<HTMLFormElement>(radio, 'form');
  if (root instanceof ShadowRoot && (!form || form.getRootNode() !== root)) {
    return [...root.querySelectorAll<HTMLInputElement>(selector)];
  }
  if (form) return querySelectorAllDeep<HTMLInputElement>(form, selector);
  return root instanceof Document || root instanceof ShadowRoot
    ? [...root.querySelectorAll<HTMLInputElement>(selector)] : [radio];
};

export class RadioAdapter implements FieldAdapter {
  supports(element: FormControlElement): element is HTMLInputElement {
    return element instanceof HTMLInputElement && element.type === 'radio';
  }

  getValue(element: FormControlElement): FormValue {
    const radio = element as HTMLInputElement;
    return radioCandidates(radio).find((candidate) => candidate.checked)?.value ?? null;
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    const radio = element as HTMLInputElement;
    const candidates = radioCandidates(radio);
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
