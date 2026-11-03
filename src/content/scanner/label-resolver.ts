import { FIELD_CONTAINER_SELECTOR } from './control-selectors';
import { closestComposed, querySelectorAllDeep } from './composed-dom';
import type { FormControlElement } from './field-filter';

const clean = (value?: string | null): string | undefined => {
  const normalized = value?.replace(/[*：:]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized || undefined;
};

/**
 * 表格内嵌控件（如费用表 cell 里的日期选择/下拉）没有 label 元素，
 * 所在列的表头 th 就是它的事实标签。对任何表格 UI 库通用（td.cellIndex → 同列 th）。
 */
const resolveTableHeader = (element: FormControlElement): string | undefined => {
  const cell = closestComposed<HTMLTableCellElement>(element, 'td');
  const table = closestComposed<HTMLTableElement>(element, 'table');
  if (!cell || !table || typeof table.querySelectorAll !== 'function') {
    return undefined;
  }
  const headers = querySelectorAllDeep<HTMLElement>(table, 'thead th, thead td');
  const index = cell.cellIndex;
  if (index < 0 || index >= headers.length) {
    return undefined;
  }
  return clean(headers[index]?.textContent);
};

/**
 * 解析控件的界面标签，优先级：
 * label[for] 的 title（AntD 把完整标签放 title，textContent 可能混入图标等装饰）
 * → label[for] textContent → 控件自身 aria-label → 包裹 label → aria-labelledby
 * → form-item 容器内 label 节点 → 表格列头 → placeholder。
 */
export const resolveLabel = (element: FormControlElement): string | undefined => {
  const root = element.getRootNode();
  const labelRoot = root instanceof Document || root instanceof ShadowRoot ? root : document;
  if (element.id) {
    const explicit = labelRoot.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`);
    if (explicit) {
      const titled = clean(explicit.getAttribute('title'));
      if (titled) {
        return titled;
      }
      const texted = clean(explicit.textContent);
      if (texted) {
        return texted;
      }
    }
  }

  const ariaLabel = clean(element.getAttribute('aria-label'));
  if (ariaLabel) {
    return ariaLabel;
  }

  const wrapping = closestComposed<HTMLLabelElement>(element, 'label');
  if (wrapping?.textContent) {
    const value =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.value
        : element.isContentEditable ? element.innerText : '';
    return clean(wrapping.textContent.replace(value, ''));
  }

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => labelRoot.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (clean(text)) {
      return clean(text);
    }
  }

  const item = closestComposed(element, FIELD_CONTAINER_SELECTOR);
  const nearby = item && querySelectorAllDeep<HTMLElement>(item, 'label, [class*="label"], .ant-form-item-label')[0];
  const containerLabel = clean(nearby?.textContent);
  if (containerLabel) {
    return containerLabel;
  }

  const tableHeader = resolveTableHeader(element);
  if (tableHeader) {
    return tableHeader;
  }

  return clean(element.getAttribute('placeholder'));
};
