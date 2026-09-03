import { FIELD_CONTAINER_SELECTOR } from './control-selectors';
import type { FormControlElement } from './field-filter';

const clean = (value?: string | null): string | undefined => {
  const normalized = value?.replace(/[*：:]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized || undefined;
};

export const resolveLabel = (element: FormControlElement): string | undefined => {
  if (element.id) {
    const explicit = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`);
    if (explicit?.textContent) {
      return clean(explicit.textContent);
    }
  }

  const wrapping = element.closest('label');
  if (wrapping?.textContent) {
    const value =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.value
        : '';
    return clean(wrapping.textContent.replace(value, ''));
  }

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (clean(text)) {
      return clean(text);
    }
  }

  const item = element.closest<HTMLElement>(FIELD_CONTAINER_SELECTOR);
  const nearby = item?.querySelector<HTMLElement>('label, [class*="label"], .ant-form-item-label');
  return clean(nearby?.textContent);
};
