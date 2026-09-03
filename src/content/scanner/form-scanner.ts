import { getFieldAdapter } from '../adapters';
import { findCustomSelectRoot } from '../adapters/custom-select-adapter';
import { findSwitchRoot } from '../adapters/switch-adapter';
import type {
  FieldType,
  FormField,
  FormScanResult,
} from '../../modules/form-clipboard/clipboard-types';
import {
  ARIA_RADIO_GROUP_SELECTOR,
  ARIA_TOGGLE_SELECTOR,
  CONTROL_COLLECT_SELECTOR,
  FORM_SCOPE_SELECTOR,
} from './control-selectors';
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
  if (findSwitchRoot(element)) {
    return 'switch';
  }
  const ariaRole = element.getAttribute('role');
  if (ariaRole === 'checkbox' || ariaRole === 'radio') {
    return ariaRole;
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
    ...scope.querySelectorAll<FormControlElement>(CONTROL_COLLECT_SELECTOR),
  ].filter((element) => {
    const customRoot = findCustomSelectRoot(element);
    if (customRoot && customRoot !== element && scope.contains(customRoot)) {
      return false;
    }
    const switchRoot = findSwitchRoot(element);
    if (switchRoot && switchRoot !== element && scope.contains(switchRoot)) {
      return false;
    }
    // 嵌套的 ARIA 控件只保留最外层（从父级开始找，元素自身不会被自身匹配）。
    const ariaRoot = element.parentElement?.closest<HTMLElement>(ARIA_TOGGLE_SELECTOR) ?? null;
    return !ariaRoot || !scope.contains(ariaRoot);
  });

const isRadioLike = (element: FormControlElement): boolean =>
  (element instanceof HTMLInputElement && element.type === 'radio') || element.getAttribute('role') === 'radio';

/** 单选组标识：原生 radio 以 name/id 为准（HTML 语义），ARIA radio 以 radiogroup 容器为准。 */
const radioGroupKey = (element: FormControlElement): string => {
  if (element instanceof HTMLInputElement) {
    return element.name || element.id || createSelector(element);
  }
  const group = element.closest<HTMLElement>(ARIA_RADIO_GROUP_SELECTOR);
  if (group) {
    return `group:${
      group.getAttribute('name') ??
      group.getAttribute('aria-label') ??
      group.getAttribute('aria-labelledby') ??
      createSelector(group)
    }`;
  }
  return `aria:${element.getAttribute('aria-labelledby') ?? element.getAttribute('name') ?? createSelector(element)}`;
};

const isRadioChecked = (element: FormControlElement): boolean =>
  element instanceof HTMLInputElement
    ? element.checked
    : element.getAttribute('aria-checked') === 'true' || element.getAttribute('data-state') === 'checked';

const scopePenalty = (scope: HTMLElement): number =>
  /search|filter|query|pagination/i.test(`${scope.id} ${scope.className}`) ? 100 : 0;

const chooseScope = (filter: FieldFilter): HTMLElement => {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(FORM_SCOPE_SELECTOR),
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
    if (isRadioLike(element)) {
      const group = radioGroupKey(element);
      if (seenRadioGroups.has(group)) {
        return [];
      }
      seenRadioGroups.add(group);
      const radios = elements.filter((candidate) => isRadioLike(candidate) && radioGroupKey(candidate) === group);
      element = radios.find(isRadioChecked) ?? element;
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
        /(?:^|\s)(?:ant|el)-select-disabled(?:\s|$)/.test(element.className) ||
        /(?:^|\s)(?:is-disabled|[\w-]+--?disabled)(?:\s|$)/.test(element.className),
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
