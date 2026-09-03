export type FormControlElement = HTMLElement;

export interface ScanContext {
  scope: HTMLElement;
}

export interface FieldFilter {
  shouldInclude(element: FormControlElement, context: ScanContext): boolean;
}

const sensitivePattern =
  /password|passwd|pwd|验证码|校验码|短信码|信用卡|银行卡|card.?number|\bcc-|one-time-code|\bcvv\b|\bcvc\b|token|secret|api.?key|access.?key|密钥|令牌/i;
const irrelevantContainerPattern = /global.?search|sidebar.?search|nav.?search|pagination|filter.?form|query.?form/i;

const descriptor = (element: FormControlElement): string =>
  [
    element.getAttribute('name'),
    element.id,
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
    element.getAttribute('autocomplete'),
  ]
    .filter(Boolean)
    .join(' ');

const isVisible = (element: FormControlElement): boolean => {
  if (element.hidden || element.closest('[hidden], [aria-hidden="true"]')) {
    return false;
  }
  const style = getComputedStyle(element);
  const visuallyReplacedControl = element.closest(
    'label, .ant-select, .el-select, .MuiAutocomplete-root, .MuiSelect-root, .mat-mdc-select, .mat-select, .n-select, .arco-select, .p-dropdown, .p-select, [role="combobox"], [role="checkbox"], [role="radio"], [class*="checkbox" i], [class*="radio" i]',
  );
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    (style.opacity !== '0' || Boolean(visuallyReplacedControl))
  );
};

export class DefaultFieldFilter implements FieldFilter {
  shouldInclude(element: FormControlElement, { scope }: ScanContext): boolean {
    if (!isVisible(element)) {
      return false;
    }

    if (element instanceof HTMLInputElement) {
      const ignoredTypes = new Set(['hidden', 'password', 'file', 'button', 'submit', 'reset', 'image']);
      const customSelectInput = Boolean(
        element.closest(
          '.ant-select, .el-select, .MuiAutocomplete-root, .MuiSelect-root, .mat-mdc-select, .mat-select, .n-select, .arco-select, .p-dropdown, .p-select, [role="combobox"]',
        ),
      );
      if (ignoredTypes.has(element.type) || (element.type === 'search' && !customSelectInput)) {
        return false;
      }
    }

    if (sensitivePattern.test(descriptor(element))) {
      return false;
    }

    if (element.closest('form')?.querySelector('input[type="password"]')) {
      return false;
    }

    const excludedArea = element.closest('header, nav, aside, [role="search"], [role="navigation"]');
    if (excludedArea) {
      return false;
    }

    let container: HTMLElement | null = element;
    while (container && container !== scope.parentElement) {
      if (irrelevantContainerPattern.test(`${container.id} ${container.className}`)) {
        return false;
      }
      container = container.parentElement;
    }
    return true;
  }
}
