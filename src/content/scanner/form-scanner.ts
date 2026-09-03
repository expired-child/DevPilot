import { getFieldAdapter } from '../adapters';
import { findCustomSelectRoot } from '../adapters/custom-select-adapter';
import { findDatePickerRoot } from '../adapters/date-picker-adapter';
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
  DIALOG_SCOPE_SELECTOR,
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
  if (findDatePickerRoot(element) && element instanceof HTMLInputElement) {
    return 'date';
  }
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

export interface RankedScope {
  scope: HTMLElement;
  score: number;
}

/** 弹窗作用域的加权：弹窗打开时用户操作的就是它，优先于背后页面里的表单。 */
const DIALOG_SCOPE_BOOST = 2;

/**
 * 按候选作用域内的有效控件数打分排序：控件越多分越高，
 * 命中弹窗容器的候选分数加倍，搜索/筛选类容器扣分。
 */
export const rankScopes = (candidates: HTMLElement[], filter: FieldFilter): RankedScope[] =>
  candidates
    .map((scope) => {
      const controls = collectFormControls(scope).filter((element) => filter.shouldInclude(element, { scope })).length;
      const score = controls * 10 - scopePenalty(scope);
      return { scope, score: scope.matches(DIALOG_SCOPE_SELECTOR) ? score * DIALOG_SCOPE_BOOST : score };
    })
    .sort((left, right) => right.score - left.score);

const chooseScope = (filter: FieldFilter): HTMLElement => {
  const candidates = [...new Set(document.querySelectorAll<HTMLElement>(FORM_SCOPE_SELECTOR))];
  const ranked = rankScopes(candidates, filter);
  return ranked[0]?.score > 0 ? ranked[0].scope : document.body;
};

/** 表单可能所在的容器：命中后容器内的标题就是「这个表单」的名字（如 .ant-modal-title）。 */
const FORM_CONTAINER_SELECTOR =
  '[role="dialog"], dialog, dialog[open], [aria-modal="true"], .ant-modal, .ant-drawer-content, .el-dialog, .el-drawer, .arco-modal, [class*="modal" i], [class*="dialog" i], [class*="drawer" i], form, fieldset';

const FORM_TITLE_SELECTOR = ['.ant-modal-title', '.el-dialog__title', '.ant-drawer-title', 'legend'].join(', ');

const HEADING_LEVELS = ['h1', 'h2', 'h3', 'h4'] as const;

const cleanTitle = (value?: string | null): string | undefined => {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
};

const firstTitleText = (nodes: Iterable<HTMLElement>): string | undefined => {
  for (const node of nodes) {
    if (node.getAttribute('aria-hidden') === 'true' || node.checkVisibility?.() === false) {
      continue;
    }
    const title = cleanTitle(node.textContent);
    if (title) {
      return title;
    }
  }
  return undefined;
};

/**
 * 命名优先级：所在弹窗/抽屉/表单容器的标题（精确到具体表单，如「诉前补充」）
 * → 业务名称字段值 → 作用域内各级标题 → 页面标题。
 * 容器标题与业务字段值同时存在时组合，如「编辑网关 · gateway-a」。
 */
export const suggestedName = (scope: HTMLElement, fields: FormField[]): string | undefined => {
  const container = scope.closest<HTMLElement>(FORM_CONTAINER_SELECTOR);
  const containerTitle =
    firstTitleText(scope.querySelectorAll<HTMLElement>(FORM_TITLE_SELECTOR)) ??
    firstTitleText(container?.querySelectorAll<HTMLElement>(FORM_TITLE_SELECTOR) ?? []);

  const obviousName = fields.find((field) => {
    const hint = `${field.name ?? ''} ${field.id ?? ''} ${field.label ?? ''}`;
    return /(^|\W)(name|title|gatewayName|routeName|serviceName)(\W|$)|名称/i.test(hint) && typeof field.value === 'string' && field.value.trim();
  });
  const obviousValue = typeof obviousName?.value === 'string' ? cleanTitle(obviousName.value) : undefined;

  if (containerTitle || obviousValue) {
    return containerTitle && obviousValue && containerTitle !== obviousValue
      ? `${containerTitle} · ${obviousValue}`
      : containerTitle ?? obviousValue;
  }

  for (const level of HEADING_LEVELS) {
    const heading = firstTitleText(scope.querySelectorAll<HTMLElement>(level));
    if (heading) {
      return heading;
    }
  }
  return (
    firstTitleText(scope.querySelectorAll<HTMLElement>('[role="heading"]')) ??
    cleanTitle(document.title) ??
    undefined
  );
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
