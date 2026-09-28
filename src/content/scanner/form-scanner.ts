import { getFieldAdapter } from '../adapters';
import { findCustomSelectRoot } from '../adapters/custom-select-adapter';
import { findDatePickerRoot } from '../adapters/date-picker-adapter';
import { findSwitchRoot } from '../adapters/switch-adapter';
import type {
  FieldType,
  FormField,
  FormScanResult,
} from '../../modules/form-clipboard/clipboard-types';
import type { FormCandidateSummary } from '../../shared/messaging/messages';
import {
  ARIA_RADIO_GROUP_SELECTOR,
  ARIA_TOGGLE_SELECTOR,
  CONTENT_EDITABLE_SELECTOR,
  CONTROL_COLLECT_SELECTOR,
  DIALOG_SCOPE_SELECTOR,
  FIELD_CONTAINER_SELECTOR,
  FORM_SCOPE_SELECTOR,
} from './control-selectors';
import { DefaultFieldFilter, type FieldFilter, type FormControlElement } from './field-filter';
import { closestComposed, composedParent, containsComposed, deepActiveElement, querySelectorAllDeep } from './composed-dom';
import { resolveLabel } from './label-resolver';
import { scopeIdOf } from './scope-registry';
import { isRendered } from './visibility';

export interface ScannedField {
  field: FormField;
  element: FormControlElement;
}

export interface ScannedForm {
  result: FormScanResult;
  controls: ScannedField[];
  scope: HTMLElement;
}

/** 聚焦在被过滤的密码框时，仍把当前表单所在 frame 视为目标。 */
export const isFocusedScannedForm = (scanned: ScannedForm, doc: Document = document): boolean => {
  const active = deepActiveElement(doc);
  if (!(active instanceof HTMLElement) || active instanceof HTMLIFrameElement) return false;
  const insideForm = Boolean(closestComposed(active, 'form, [role="form"], .ant-form, .el-form'));
  return (insideForm || active.matches(CONTROL_COLLECT_SELECTOR)) && containsComposed(scanned.scope, active);
};

const selectorText = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const localSelector = (element: HTMLElement, root: Document | ShadowRoot): string => {
  const unique = (selector: string): boolean => root.querySelectorAll(selector).length === 1;
  if (element.id && unique(`#${CSS.escape(element.id)}`)) {
    return `#${CSS.escape(element.id)}`;
  }
  const name = element.getAttribute('name');
  if (name) {
    const type = element instanceof HTMLInputElement ? `[type="${selectorText(element.type)}"]` : '';
    const selector = `${element.tagName.toLowerCase()}${type}[name="${selectorText(name)}"]`;
    if (unique(selector)) return selector;
  }
  const testId = element.getAttribute('data-testid');
  if (testId && unique(`[data-testid="${selectorText(testId)}"]`)) {
    return `[data-testid="${selectorText(testId)}"]`;
  }

  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== element.ownerDocument.body) {
    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? [...current.parentElement.children].filter((child) => child.tagName === current?.tagName)
      : [];
    const position = siblings.indexOf(current) + 1;
    parts.unshift(`${tag}:nth-of-type(${Math.max(position, 1)})`);
    current = current.parentElement;
  }
  return root instanceof Document ? `body > ${parts.join(' > ')}` : parts.join(' > ');
};

const selectorSegments = (element: HTMLElement): string[] => {
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) {
    return [...selectorSegments(root.host as HTMLElement), localSelector(element, root)];
  }
  return [localSelector(element, element.ownerDocument)];
};

const createSelector = (element: FormControlElement): string => {
  const segments = selectorSegments(element);
  return segments.length === 1 ? segments[0] : `shadow:${JSON.stringify(segments)}`;
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
  if (element.isContentEditable) {
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

export const collectFormControls = (scope: ParentNode): FormControlElement[] => {
  const candidates = querySelectorAllDeep<FormControlElement>(scope, CONTROL_COLLECT_SELECTOR);
  const collected = new Set(candidates);
  return candidates.filter((element) => {
    const customRoot = findCustomSelectRoot(element);
    if (customRoot && customRoot !== element && collected.has(customRoot)) {
      return false;
    }
    const switchRoot = findSwitchRoot(element);
    if (switchRoot && switchRoot !== element && scope instanceof Element && containsComposed(scope, switchRoot)) {
      return false;
    }
    // 嵌套的 ARIA 控件只保留最外层（从父级开始找，元素自身不会被自身匹配）。
    const parent = composedParent(element);
    const ariaRoot = parent && closestComposed(parent, ARIA_TOGGLE_SELECTOR);
    if (ariaRoot && scope instanceof Element && containsComposed(scope, ariaRoot)) return false;
    const editableRoot = element.matches(CONTENT_EDITABLE_SELECTOR) && parent && closestComposed(parent, CONTENT_EDITABLE_SELECTOR);
    return !editableRoot || !(scope instanceof Element && containsComposed(scope, editableRoot));
  });
};

const isRadioLike = (element: FormControlElement): boolean =>
  (element instanceof HTMLInputElement && element.type === 'radio') || element.getAttribute('role') === 'radio';

/** 单选组标识：原生 radio 以 name/id 为准（HTML 语义），ARIA radio 以 radiogroup 容器为准。 */
const radioGroupKey = (element: FormControlElement): string => {
  if (element instanceof HTMLInputElement) {
    const root = element.getRootNode();
    const form = closestComposed(element, 'form');
    const namespace = form && form.getRootNode() === root
      ? createSelector(form)
      : root instanceof ShadowRoot ? createSelector(root.host as HTMLElement) : 'document';
    return `${namespace}:${element.name || element.id || createSelector(element)}`;
  }
  const group = closestComposed(element, ARIA_RADIO_GROUP_SELECTOR);
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

const scopePenalty = (scope: HTMLElement): number => {
  if (/search|filter|query|pagination/i.test(`${scope.id} ${scope.className}`)) return 100;
  if (scope.matches('form') && querySelectorAllDeep(scope, 'input[type="search"]').length > 0 &&
    querySelectorAllDeep(scope, 'input:not([type="search"]):not([type="hidden"]):not([type="submit"]), textarea, select, [role="combobox"]').length === 0) {
    return 100;
  }
  return 0;
};

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

/** 无 form 容器时，多个同级字段项属于同一组，避免只复制第一个字段。 */
const siblingFieldGroup = (scope: HTMLElement, filter: FieldFilter): HTMLElement | null => {
  const root = scope.getRootNode();
  const parent = scope.parentElement ?? (root instanceof ShadowRoot ? root.host as HTMLElement : null);
  if (!parent || parent === document.body || !scope.matches(FIELD_CONTAINER_SELECTOR)) return null;
  const children = scope.parentElement?.children ?? (root instanceof ShadowRoot ? root.children : []);
  const siblings = [...children].filter((child): child is HTMLElement =>
    child instanceof HTMLElement && child.matches(FIELD_CONTAINER_SELECTOR) && isRendered(child) &&
    collectFormControls(child).some((element) => filter.shouldInclude(element, { scope: parent })),
  );
  return siblings.length > 1 && siblings.includes(scope) ? parent : null;
};

const chooseScope = (filter: FieldFilter): HTMLElement => {
  const candidates = [...new Set(querySelectorAllDeep(document, FORM_SCOPE_SELECTOR))].filter(isRendered);
  // 弹窗是操作边界，不能用字段数量与背景页面竞争；无可复制字段时也不能退回背景。
  const dialogs = candidates.filter((scope) => scope.matches(DIALOG_SCOPE_SELECTOR) && (
    scope.matches('[role="dialog"], dialog[open], [aria-modal="true"]') ||
    querySelectorAllDeep(scope, CONTROL_COLLECT_SELECTOR).length > 0
  ));
  const active = deepActiveElement(document);
  const focusedDialogs = dialogs.filter((scope) => active && containsComposed(scope, active));
  if (dialogs.length > 0) {
    return rankScopes(focusedDialogs.length ? focusedDialogs : dialogs, filter)[0].scope;
  }
  const focusedForm = active && closestComposed(active, 'form, [role="form"], .ant-form, .el-form');
  if (focusedForm && isRendered(focusedForm)) return focusedForm;
  // main 等公共容器不能把多个独立表单合并为一次复制。
  const forms = candidates.filter((scope) => scope.matches('form, [role="form"], .ant-form, .el-form'));
  const rankedForms = rankScopes(forms, filter);
  if (rankedForms[0]?.score > 0) return rankedForms[0].scope;
  const ranked = rankScopes(candidates, filter);
  const focused = ranked.find((entry) => active && containsComposed(entry.scope, active));
  const selected = focused?.score ? focused : ranked[0];
  return selected?.score > 0 ? siblingFieldGroup(selected.scope, filter) ?? selected.scope : document.body;
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
    if (!isRendered(node)) {
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
  const container = closestComposed(scope, FORM_CONTAINER_SELECTOR);
  const containerTitle =
    firstTitleText(querySelectorAllDeep(scope, FORM_TITLE_SELECTOR)) ??
    firstTitleText(container ? querySelectorAllDeep(container, FORM_TITLE_SELECTOR) : []);

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
    const heading = firstTitleText(querySelectorAllDeep(scope, level));
    if (heading) {
      return heading;
    }
  }
  return (
    firstTitleText(querySelectorAllDeep(scope, '[role="heading"]')) ??
    cleanTitle(document.title) ??
    undefined
  );
};

export const scanForm = (
  doc: Document = document,
  filter: FieldFilter = new DefaultFieldFilter(),
  fixedScope?: HTMLElement,
): ScannedForm => {
  // 每个 iframe 有独立内容脚本与 document；doc 参数保留为兼容调用接口。
  void doc;
  const scope = fixedScope ?? chooseScope(filter);
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
        element.matches(':disabled') || element.hasAttribute('disabled') ||
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
    scope,
    controls: scanned,
    result: {
      suggestedName: suggestedName(scope, fields),
      source: {
        url: location.href,
        title: document.title || undefined,
        host: location.host,
      },
      fields,
      scopeId: scopeIdOf(scope),
    },
  };
};

/**
 * 列出当前 frame 的候选表单：复用 chooseScope 的可见性、弹窗与焦点规则所用的识别基础，
 * 去重控件集合相同的嵌套作用域（如弹窗容器与其内部 <form>），只返回概要不返回字段值。
 */
export const listFormCandidates = (
  filter: FieldFilter = new DefaultFieldFilter(),
): FormCandidateSummary[] => {
  const formSelector = 'form, [role="form"], .ant-form, .el-form';
  const sameControls = (left: Set<HTMLElement>, right: Set<HTMLElement>): boolean =>
    left.size === right.size && [...left].every((element) => right.has(element));
  const candidates = [...new Set(querySelectorAllDeep(document, FORM_SCOPE_SELECTOR))]
    .filter(isRendered)
    .map((scope) => {
      const scanned = scanForm(document, filter, scope);
      return { scope, scanned, controls: new Set(scanned.controls.map(({ element }) => element)) };
    })
    .filter(({ controls }) => controls.size > 0);
  // 无显式表单容器的普通页面沿用旧扫描路径，不丢失直接放在 body 下的字段。
  if (candidates.length === 0) {
    const scanned = scanForm(document, filter, document.body);
    if (scanned.controls.length > 0) {
      candidates.push({
        scope: document.body,
        scanned,
        controls: new Set(scanned.controls.map(({ element }) => element)),
      });
    }
  }
  const hasBusinessCandidate = candidates.some(({ scope }) => scopePenalty(scope) < 100);
  const eligibleCandidates = hasBusinessCandidate
    ? candidates.filter(({ scope }) => scopePenalty(scope) < 100 || scope.matches(DIALOG_SCOPE_SELECTOR))
    : candidates;
  const concreteForms = eligibleCandidates.filter(({ scope }) => scope.matches(formSelector));
  // 弹窗优先保留操作边界；普通 form 优先于 main 等泛容器。
  eligibleCandidates.sort((left, right) => {
    const priority = (scope: HTMLElement): number =>
      scope.matches(DIALOG_SCOPE_SELECTOR) ? 0 : scope.matches(formSelector) ? 1 : 2;
    return priority(left.scope) - priority(right.scope);
  });
  const seenControls: Array<Set<HTMLElement>> = [];
  const summaries: FormCandidateSummary[] = [];
  for (const { scope, scanned, controls } of eligibleCandidates) {
    const innerForms = concreteForms
      .filter((entry) => entry.scope !== scope && containsComposed(scope, entry.scope))
      .map((entry) => entry.controls)
      .filter((entry, index, all) => all.findIndex((other) => sameControls(entry, other)) === index);
    // main、弹窗等外层容器不能把两个独立表单合成一个候选。
    if (innerForms.length > 1 || seenControls.some((entry) => sameControls(entry, controls))) continue;
    seenControls.push(controls);
    summaries.push({
      scopeId: scopeIdOf(scope),
      title: scanned.result.suggestedName,
      fieldCount: scanned.result.fields.length,
      fieldLabels: scanned.result.fields.slice(0, 3).map((field) => field.label || field.name || field.key),
      dialog: scope.matches(DIALOG_SCOPE_SELECTOR),
      focused: isFocusedScannedForm(scanned),
      source: scanned.result.source,
    });
  }
  return summaries;
};
