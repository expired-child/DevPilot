import { getFieldAdapter } from '../adapters';
import { findCustomSelectRoot } from '../adapters/custom-select-adapter';
import type {
  FieldType,
  FormField,
  FormScanResult,
} from '../../modules/form-clipboard/clipboard-types';
import { DefaultFieldFilter, type FieldFilter, type FormControlElement } from './field-filter';
import { resolveLabel } from './label-resolver';

export interface ScannedField {
  field: FormField;
  element: FormControlElement;
}

export interface ScannedForm {
  result: FormScanResult;
  controls: ScannedField[];
}

const selectorText = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const createSelector = (element: FormControlElement): string => {
  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }
  const name = element.getAttribute('name');
  if (name) {
    const type = element instanceof HTMLInputElement ? `[type="${selectorText(element.type)}"]` : '';
    return `${element.tagName.toLowerCase()}${type}[name="${selectorText(name)}"]`;
  }
  const testId = element.getAttribute('data-testid');
  if (testId) {
    return `[data-testid="${selectorText(testId)}"]`;
  }

  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && parts.length < 4) {
    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? [...current.parentElement.children].filter((child) => child.tagName === current?.tagName)
      : [];
    const position = siblings.indexOf(current) + 1;
    parts.unshift(`${tag}:nth-of-type(${Math.max(position, 1)})`);
    current = current.parentElement;
  }
  return parts.join(' > ');
};

const resolveType = (element: FormControlElement): FieldType => {
  if (findCustomSelectRoot(element)) {
    return 'select';
  }
  if (element instanceof HTMLTextAreaElement) {
    return 'textarea';
  }
  if (element instanceof HTMLSelectElement) {
    return 'select';
  }
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      return element.type;
    }
    const supported: FieldType[] = ['number', 'email', 'url', 'tel', 'date', 'datetime-local', 'time'];
    return supported.includes(element.type as FieldType) ? (element.type as FieldType) : 'text';
  }
  return 'text';
};

const fieldKey = (field: Omit<FormField, 'key'>): string => {
  if (field.name) return `name:${field.name}`;
  if (field.id) return `id:${field.id}`;
  if (field.label) return `label:${field.label}`;
  if (field.ariaLabel) return `aria:${field.ariaLabel}`;
  if (field.placeholder) return `placeholder:${field.placeholder}`;
  return `selector:${field.selector ?? ''}`;
};

export const collectFormControls = (scope: ParentNode): FormControlElement[] =>
  [
    ...scope.querySelectorAll<FormControlElement>(
      'input, textarea, select, .ant-select, .el-select, .MuiAutocomplete-root, .MuiSelect-root, .mat-mdc-select, .mat-select, .n-select, .arco-select, .p-dropdown, .p-select, [class*="react-select__control"], [role="combobox"]',
    ),
  ].filter((element) => {
    const customRoot = findCustomSelectRoot(element);
    return !customRoot || customRoot === element || !scope.contains(customRoot);
  });

const scopePenalty = (scope: HTMLElement): number =>
  /search|filter|query|pagination/i.test(`${scope.id} ${scope.className}`) ? 100 : 0;

const chooseScope = (filter: FieldFilter): HTMLElement => {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>('form, [role="dialog"], main, .ant-form, .el-form, [class*="form"]'),
  ];
  const unique = [...new Set(candidates)];
  const ranked = unique
    .map((scope) => ({
      scope,
      score:
        collectFormControls(scope).filter((element) => filter.shouldInclude(element, { scope })).length * 10 -
        scopePenalty(scope),
    }))
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.score > 0 ? ranked[0].scope : document.body;
};

const suggestedName = (scope: HTMLElement, fields: FormField[]): string | undefined => {
  const obviousName = fields.find((field) => {
    const hint = `${field.name ?? ''} ${field.id ?? ''} ${field.label ?? ''}`;
    return /(^|\W)(name|title|gatewayName|routeName|serviceName)(\W|$)|名称/i.test(hint) && typeof field.value === 'string' && field.value.trim();
  });
  if (typeof obviousName?.value === 'string') {
    return obviousName.value.trim();
  }
  const heading = scope.querySelector<HTMLElement>('h1, h2, h3, [role="heading"], .ant-modal-title, .el-dialog__title');
  return heading?.textContent?.trim() || document.title.trim() || undefined;
};

export const scanForm = (
  doc: Document = document,
  filter: FieldFilter = new DefaultFieldFilter(),
): ScannedForm => {
  // doc 参数用于后续测试和 iframe 扩展；当前内容脚本始终处理所属 document。
  void doc;
  const scope = chooseScope(filter);
  const elements = collectFormControls(scope).filter((element) => filter.shouldInclude(element, { scope }));
  const seenRadioGroups = new Set<string>();
  const initial = elements.flatMap<ScannedField>((element) => {
    if (element instanceof HTMLInputElement && element.type === 'radio') {
      const group = element.name || element.id || createSelector(element);
      if (seenRadioGroups.has(group)) {
        return [];
      }
      seenRadioGroups.add(group);
      const radios = elements.filter(
        (candidate): candidate is HTMLInputElement =>
          candidate instanceof HTMLInputElement && candidate.type === 'radio' && (candidate.name || candidate.id) === group,
      );
      element = radios.find((radio) => radio.checked) ?? element;
    }

    const adapter = getFieldAdapter(element);
    if (!adapter) {
      return [];
    }
    const selector = createSelector(element);
    const partial: Omit<FormField, 'key'> = {
      label: resolveLabel(element),
      name: element.getAttribute('name') || undefined,
      id: element.id || undefined,
      placeholder: element.getAttribute('placeholder') || undefined,
      ariaLabel: element.getAttribute('aria-label') || undefined,
      selector,
      type: resolveType(element),
      value: adapter.getValue(element),
      required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
      disabled:
        element.hasAttribute('disabled') ||
        element.getAttribute('aria-disabled') === 'true' ||
        /(?:^|\s)(?:ant|el)-select-disabled(?:\s|$)/.test(element.className),
      metadata: {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') ?? '',
      },
    };
    return [{ field: { ...partial, key: fieldKey(partial) }, element }];
  });

  const counts = initial.reduce<Record<string, number>>((result, entry) => {
    result[entry.field.key] = (result[entry.field.key] ?? 0) + 1;
    return result;
  }, {});
  const scanned = initial.map((entry) => ({
    ...entry,
    field:
      counts[entry.field.key] > 1
        ? { ...entry.field, key: `${entry.field.key}|selector:${entry.field.selector}` }
        : entry.field,
  }));
  const fields = scanned.map(({ field }) => field);

  return {
    controls: scanned,
    result: {
      suggestedName: suggestedName(scope, fields),
      source: {
        url: location.href,
        title: document.title || undefined,
        host: location.host,
      },
      fields,
    },
  };
};
