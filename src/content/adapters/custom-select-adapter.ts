import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import {
  COMBOBOX_SELECTOR,
  CUSTOM_SELECT_ROOT_SELECTOR,
  DROPDOWN_HIDDEN_SELECTOR,
  DROPDOWN_OPTION_SELECTOR,
  DROPDOWN_POPUP_SELECTOR,
  DROPDOWN_TRIGGER_SELECTOR,
  GENERIC_DROPDOWN_ARIA_SELECTOR,
  GENERIC_DROPDOWN_MAX_DEPTH,
  GENERIC_OPTION_SELECTOR,
  GENERIC_POPUP_SELECTOR,
  isMultipleSelect,
  matchesDropdownClassToken,
  SELECTED_VALUE_SELECTOR,
} from '../scanner/control-selectors';
import type { FormControlElement } from '../scanner/field-filter';
import { dispatchValueEvents, setNativeValue, type FieldAdapter } from './field-adapter';
import { findDatePickerRoot } from './date-picker-adapter';
import { readReactValue } from './react-props';

const text = (value?: string | null): string => value?.replace(/\s+/g, ' ').trim() ?? '';
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

/** 通用语义下的下拉容器：ARIA 弹出层属性或「下拉」语义的类名 token。 */
const isGenericDropdownContainer = (element: HTMLElement): boolean =>
  Boolean(
    (typeof element.matches === 'function' && element.matches(GENERIC_DROPDOWN_ARIA_SELECTOR)) ||
      matchesDropdownClassToken(element) ||
      element.getAttribute?.('data-role') === 'dropdown',
  );

/**
 * 未知自研下拉的兜底探测：框架类名表覆盖不到时（如内部组件库的 SearchSelect），
 * 沿祖先链找带 ARIA 弹出层语义或下拉类名 token 的容器。
 * 层数受限，避免把整个表单容器当成下拉。
 */
export const findGenericDropdownRoot = (element: HTMLElement): HTMLElement | null => {
  let current: HTMLElement | null = element;
  for (let depth = 0; current && depth < GENERIC_DROPDOWN_MAX_DEPTH; depth += 1, current = current.parentElement) {
    if (isGenericDropdownContainer(current)) {
      return current;
    }
  }
  return null;
};

export const findCustomSelectRoot = (element: HTMLElement): HTMLElement | null => {
  // 日期控件由 DatePickerAdapter 处理（面板里没有可点的 option，走下拉流程必然失败）。
  if (findDatePickerRoot(element)) {
    return null;
  }

  const frameworkRoot = element.closest<HTMLElement>(CUSTOM_SELECT_ROOT_SELECTOR);
  if (frameworkRoot) {
    return frameworkRoot;
  }

  const combobox = element.matches(COMBOBOX_SELECTOR) ? element : element.closest<HTMLElement>(COMBOBOX_SELECTOR);
  if (combobox) {
    let current = combobox.parentElement;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      if (current.querySelector('[class*="singleValue"], [class*="indicatorsContainer"]')) {
        return current;
      }
    }
    return combobox;
  }

  return findGenericDropdownRoot(element);
};

/** 命中已知框架类名的下拉才是「确定」的下拉，通用探测命中的只能算疑似。 */
const isDefiniteSelect = (element: FormControlElement): boolean =>
  Boolean(element.closest<HTMLElement>(CUSTOM_SELECT_ROOT_SELECTOR)) ||
  element.matches(COMBOBOX_SELECTOR) ||
  Boolean(element.closest<HTMLElement>(COMBOBOX_SELECTOR));

export const readSelectedText = (root: ParentNode): FormValue => {
  const selected = [
    ...new Set(
      [...root.querySelectorAll<HTMLElement>(SELECTED_VALUE_SELECTOR)]
        .map((element) => text(element.textContent))
        .filter(Boolean),
    ),
  ];
  if (selected.length > 1) {
    return selected;
  }
  if (selected.length === 1) {
    return selected[0];
  }

  const rootElement = root as HTMLElement;
  if (
    typeof rootElement.matches === 'function' &&
    rootElement.matches(`${COMBOBOX_SELECTOR}, .MuiSelect-select`)
  ) {
    const ariaValue = rootElement.getAttribute('aria-valuetext');
    if (ariaValue || (!rootElement.querySelector('input') && text(rootElement.textContent))) {
      return ariaValue || text(rootElement.textContent);
    }
  }

  const input = root.querySelector<HTMLInputElement>('input');
  return input?.value ?? '';
};

/** 选项行首的装饰字符（勾选图标等），前缀兜底匹配前剥掉。 */
const LEADING_DECORATION = /^[\s✓✔√●·]+/;

export const findMatchingOption = (
  options: HTMLElement[],
  value: string,
): HTMLElement | undefined => {
  const target = text(value);
  if (!target) {
    return undefined;
  }
  const exact = options.find((option) => text(option.textContent) === target);
  if (exact) {
    return exact;
  }
  // 自研选项节点常混入勾选图标等多余文本：剥掉行首装饰后按前缀兜底。
  // 只做 startsWith 不做 includes，避免「还车」误中「未还车」这类近似项。
  return options.find((option) => text(option.textContent).replace(LEADING_DECORATION, '').startsWith(target));
};

const isVisible = (option: HTMLElement): boolean => {
  const style = getComputedStyle(option);
  const popup = option.closest<HTMLElement>(DROPDOWN_POPUP_SELECTOR);
  const popupStyle = popup ? getComputedStyle(popup) : null;
  return (
    !option.closest(DROPDOWN_HIDDEN_SELECTOR) &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    popupStyle?.display !== 'none' &&
    popupStyle?.visibility !== 'hidden' &&
    option.getClientRects().length > 0
  );
};

const visibleOptions = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>(DROPDOWN_OPTION_SELECTOR)].filter(isVisible);

/**
 * 自研下拉的通用选项探测：框架类名表覆盖不到时（如 ehi-select teleport 浮层），
 * 按 ARIA 角色/类名 token 兜底，且要求选项归属某个浮层容器，
 * 避免把页面上普通的列表项当成下拉选项。
 */
export const visibleGenericOptions = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>(GENERIC_OPTION_SELECTOR)].filter(
    (option) =>
      isVisible(option) &&
      (option.matches('[role="option"]') || Boolean(option.closest(GENERIC_POPUP_SELECTOR))),
  );

const clickOption = (option: HTMLElement): void => {
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
  option.click();
};

/** 在触发区上模拟一次用户点击：展开与收起都是它（toggle 行为）。 */
const toggleSelect = (root: HTMLElement, element: FormControlElement): void => {
  const trigger = root.querySelector<HTMLElement>(DROPDOWN_TRIGGER_SELECTOR) ?? element;
  trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
  trigger.click();
};

const openSelect = toggleSelect;

/**
 * 多选下拉点击选项后通常不会自动收起，需要补一次 trigger 点击（toggle 收起）。
 * 注意：不要派发 Escape/focusout 等合成事件——它们会冒泡到 document，
 * 被弹窗组件（AntD Modal / Element Dialog 等）的键盘监听误消费，导致表单弹窗被关闭。
 */
const closeSelect = toggleSelect;

export class CustomSelectAdapter implements FieldAdapter {
  supports(element: FormControlElement): boolean {
    return !(element instanceof HTMLSelectElement) && Boolean(findCustomSelectRoot(element));
  }

  getValue(element: FormControlElement): FormValue {
    const root = findCustomSelectRoot(element) ?? element;
    const selected = readSelectedText(root);
    const domValue = selected === '' && element instanceof HTMLInputElement ? element.value : selected;
    // DOM 上取不到时回退 React 内部值：自研组件常有值只在 fiber 里的情况。
    const value = domValue === '' || domValue === null ? (readReactValue(element) ?? domValue) : domValue;
    if (isMultipleSelect(root) && !Array.isArray(value)) {
      return value === '' || value === null ? [] : [String(value)];
    }
    return value;
  }

  async setValue(element: FormControlElement, value: FormValue): Promise<void> {
    const root = findCustomSelectRoot(element);
    if (!root) {
      throw new Error('未找到下拉框容器');
    }

    const values = (Array.isArray(value) ? value : [value])
      .map((entry) => String(entry ?? '').trim())
      .filter(Boolean);
    if (values.length === 0) {
      throw new Error('未获取到要填充的下拉值');
    }

    // 已选中的项不重复点击，保证重复粘贴同一份数据时幂等。
    const current = this.getValue(element);
    const selected = new Set(Array.isArray(current) ? current.map(String) : [String(current ?? '')]);

    // 基线：展开前页面已可见的「选项样」节点（如导航菜单项、其他常驻浮层）
    // 不参与匹配，只有本次展开后新出现的选项才可点，防止误点页面既有节点。
    const baseline = new Set(visibleGenericOptions());
    openSelect(root, element);
    const missing: string[] = [];
    for (const target of values) {
      if (selected.has(target)) {
        continue;
      }
      let option: HTMLElement | undefined;
      for (let attempt = 0; attempt < 20 && !option; attempt += 1) {
        await wait(50);
        const generic = visibleGenericOptions().filter((candidate) => !baseline.has(candidate));
        option = findMatchingOption([...visibleOptions(), ...generic], target);
      }
      if (!option) {
        missing.push(target);
        continue;
      }
      clickOption(option);
      await wait(80);
    }
    // 单选点击选项后框架会自动收起；多选需要手动 toggle 收起。
    if (isMultipleSelect(root)) {
      closeSelect(root, element);
      await wait(80);
    }

    if (missing.length === 0) {
      return;
    }

    // 通用语义识别的下拉可能是误判（自研组件 DOM 结构千差万别）：
    // 一个选项都点不到时回退为直接输入，而不是让整个字段填充失败。
    if (!isDefiniteSelect(element)) {
      const input = element instanceof HTMLInputElement
        ? element
        : root.querySelector<HTMLInputElement>('input');
      if (input) {
        setNativeValue(input, values.join(','));
        dispatchValueEvents(input);
        return;
      }
    }

    throw new Error(`未找到下拉选项：${missing.join('、')}`);
  }
}
