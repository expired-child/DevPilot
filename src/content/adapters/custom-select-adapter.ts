import type { FormValue } from '../../modules/form-clipboard/clipboard-types';
import {
  CASCADER_ROOT_SELECTOR,
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
import { closestComposed, composedParent, querySelectorAllDeep } from '../scanner/composed-dom';
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
  for (let depth = 0; current && depth < GENERIC_DROPDOWN_MAX_DEPTH; depth += 1, current = composedParent(current)) {
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

  const frameworkRoot = closestComposed(element, CUSTOM_SELECT_ROOT_SELECTOR);
  if (frameworkRoot) {
    return frameworkRoot;
  }

  const combobox = element.matches(COMBOBOX_SELECTOR) ? element : closestComposed(element, COMBOBOX_SELECTOR);
  if (combobox) {
    let current = composedParent(combobox);
    for (let depth = 0; current && depth < 4; depth += 1, current = composedParent(current)) {
      if (querySelectorAllDeep(current, '[class*="singleValue"], [class*="indicatorsContainer"]').length) {
        return current;
      }
    }
    return combobox;
  }

  return findGenericDropdownRoot(element);
};

/** 命中已知框架类名的下拉才是「确定」的下拉，通用探测命中的只能算疑似。 */
const isDefiniteSelect = (element: FormControlElement): boolean =>
  Boolean(closestComposed(element, CUSTOM_SELECT_ROOT_SELECTOR)) ||
  element.matches(COMBOBOX_SELECTOR) ||
  Boolean(closestComposed(element, COMBOBOX_SELECTOR));

export const readSelectedText = (root: ParentNode): FormValue => {
  const selected = [
    ...new Set(
      querySelectorAllDeep(root, SELECTED_VALUE_SELECTOR)
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
  if (typeof rootElement.matches === 'function' && rootElement.matches(`${COMBOBOX_SELECTOR}, .MuiSelect-select`)) {
    const ariaValue = text(rootElement.getAttribute('aria-valuetext'));
    if (ariaValue || (querySelectorAllDeep(root, 'input').length === 0 && text(rootElement.innerText))) {
      return ariaValue || text(rootElement.innerText);
    }
  }

  // 输入框本身可能就是组合框（root === input），不能只查后代。
  const input = root instanceof HTMLInputElement
    ? root
    : querySelectorAllDeep<HTMLInputElement>(root, 'input')[0];
  const inputValue = input?.value ?? '';
  if (inputValue) {
    return inputValue;
  }

  // 自研下拉的选中文本可能既不在已知选择器里，也不在 input.value 里（input 只承担搜索）。
  // 仅在容器本身具备下拉语义时回退到可见文本，避免把整个字段容器（含 label）误当成值。
  if (
    typeof rootElement.matches === 'function' &&
    (rootElement.matches(`${COMBOBOX_SELECTOR}, [aria-haspopup]`) || matchesDropdownClassToken(rootElement))
  ) {
    const placeholder =
      text(rootElement.getAttribute('data-placeholder')) ||
      text(rootElement.getAttribute('placeholder')) ||
      text(querySelectorAllDeep(rootElement, '[class*="placeholder" i]')[0]?.textContent);
    const rootText = text(rootElement.innerText);
    if (rootText && rootText !== placeholder) {
      return rootText;
    }
  }
  return inputValue;
};

/** 选项行首的装饰字符（勾选图标等），前缀兜底匹配前剥掉。 */
const LEADING_DECORATION = /^[\s✓✔√●·]+/;

/** 选项上可能承载真实值/可访问名称的属性：显示文本与提交值不一致时靠它们兜底。 */
const optionAttributes = (option: HTMLElement): string[] =>
  [
    option.getAttribute('value'),
    option.getAttribute('data-value'),
    option.getAttribute('aria-label'),
    option.getAttribute('title'),
  ]
    .map(text)
    .filter(Boolean);

export const findMatchingOption = (
  options: HTMLElement[],
  value: string,
  excluded: Set<HTMLElement> = new Set(),
): HTMLElement | undefined => {
  const target = text(value);
  if (!target) {
    return undefined;
  }
  const pool = options.filter((option) => !excluded.has(option));
  const exact = pool.find((option) => text(option.textContent) === target);
  if (exact) {
    return exact;
  }
  const byAttribute = pool.find((option) => optionAttributes(option).includes(target));
  if (byAttribute) {
    return byAttribute;
  }
  // 自研选项节点常混入勾选图标等多余文本：剥掉行首装饰后按前缀兜底。
  // 只做 startsWith 不做 includes，避免「还车」误中「未还车」这类近似项。
  return pool.find((option) => text(option.textContent).replace(LEADING_DECORATION, '').startsWith(target));
};

const isVisible = (option: HTMLElement): boolean => {
  const style = getComputedStyle(option);
  const popup = closestComposed(option, DROPDOWN_POPUP_SELECTOR);
  const popupStyle = popup ? getComputedStyle(popup) : null;
  return (
    !closestComposed(option, DROPDOWN_HIDDEN_SELECTOR) &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    popupStyle?.display !== 'none' &&
    popupStyle?.visibility !== 'hidden' &&
    option.getClientRects().length > 0
  );
};

const visibleOptions = (): HTMLElement[] =>
  querySelectorAllDeep(document, DROPDOWN_OPTION_SELECTOR).filter(isVisible);

/**
 * 自研下拉的通用选项探测：框架类名表覆盖不到时（如 ehi-select teleport 浮层），
 * 按 ARIA 角色/类名 token 兜底，且要求选项归属某个浮层容器，
 * 避免把页面上普通的列表项当成下拉选项。
 */
export const visibleGenericOptions = (): HTMLElement[] =>
  querySelectorAllDeep(document, GENERIC_OPTION_SELECTOR).filter(
    (option) =>
      isVisible(option) &&
      (option.matches('[role="option"]') || Boolean(closestComposed(option, GENERIC_POPUP_SELECTOR))),
  );

const clickOption = (option: HTMLElement): void => {
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
  option.click();
};

/** 在触发区上模拟一次用户点击：展开与收起都是它（toggle 行为）。 */
const toggleSelect = (root: HTMLElement, element: FormControlElement): void => {
  // 没有命中框架触发区时，优先点根节点内部的原生输入框：点击会冒泡到容器，
  // 同时也能覆盖「只监听输入框焦点/点击」的自研下拉（如级联选择器）。
  const trigger = querySelectorAllDeep(root, DROPDOWN_TRIGGER_SELECTOR)[0] ??
    (root instanceof HTMLInputElement
      ? root
      : querySelectorAllDeep<HTMLElement>(root, 'input:not([type="hidden"]), textarea')[0] ?? element);
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

    // 级联下拉的显示值是「省 / 市」这样的路径，需要按层级依次点击。
    const targets = root.matches(CASCADER_ROOT_SELECTOR) && values.length === 1
      ? values[0].split(/\s*\/\s*/).map((entry) => entry.trim()).filter(Boolean)
      : values;

    // 基线：展开前页面已可见的「选项样」节点（如导航菜单项、其他常驻浮层）
    // 不参与匹配，只有本次展开后新出现的选项才可点，防止误点页面既有节点。
    const baseline = new Set(visibleGenericOptions());
    const optionPool = (): HTMLElement[] => [
      ...visibleOptions(),
      ...visibleGenericOptions().filter((candidate) => !baseline.has(candidate)),
    ];
    const currentValues = (): string[] => {
      const current = this.getValue(element);
      return (Array.isArray(current) ? current : [current])
        .map((entry) => text(String(entry ?? '')))
        .filter(Boolean);
    };

    let opened = false;
    const ensureOpen = async (): Promise<boolean> => {
      if (optionPool().length > 0) {
        opened = true;
        return true;
      }
      openSelect(root, element);
      opened = true;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await wait(50);
        if (optionPool().length > 0) return true;
      }
      // 部分 ARIA combobox 只响应键盘展开，点击后仍没有选项时再补一次 ArrowDown。
      const keyboardTarget = element instanceof HTMLInputElement
        ? element
        : querySelectorAllDeep<HTMLElement>(element, 'input:not([type="hidden"]), textarea, [tabindex]')[0] ?? element;
      keyboardTarget.focus?.();
      for (const type of ['keydown', 'keyup']) {
        keyboardTarget.dispatchEvent(
          new KeyboardEvent(type, { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, composed: true }),
        );
      }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await wait(50);
        if (optionPool().length > 0) return true;
      }
      return false;
    };

    const waitForOption = async (
      target: string,
      clicked: Set<HTMLElement>,
    ): Promise<HTMLElement | undefined> => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait(50);
        const option = findMatchingOption(optionPool(), target, clicked);
        if (option) return option;
      }
      return undefined;
    };

    /** 可输入的下拉（搜索/远程搜索）：选项可能只有输入关键字后才渲染。 */
    const searchInput = (): HTMLInputElement | undefined => {
      if (element instanceof HTMLInputElement) {
        return element.readOnly || element.disabled ? undefined : element;
      }
      return querySelectorAllDeep<HTMLInputElement>(root, 'input:not([type="hidden"])')
        .find((input) => !input.readOnly && !input.disabled);
    };
    const typeSearch = (input: HTMLInputElement, target: string): void => {
      input.focus();
      setNativeValue(input, target);
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: target,
      }));
    };
    /** 虚拟滚动列表只渲染可视区域的选项，需要边滚动边查找目标项。 */
    const scrollableOptionList = (): HTMLElement | null => {
      const scrollable = (node: HTMLElement): boolean => node.scrollHeight > node.clientHeight + 4;
      // 从选项向内层祖先找起，优先命中最里层的虚拟滚动容器（外层弹层往往也能滚动）。
      for (const option of optionPool()) {
        for (let node = option.parentElement; node; node = node.parentElement) {
          if (scrollable(node)) return node;
          if (node.matches(DROPDOWN_POPUP_SELECTOR)) break;
        }
      }
      return querySelectorAllDeep(
        document,
        '.rc-virtual-list-holder, .el-select-dropdown__wrap, .ant-select-dropdown, .el-select-dropdown, [role="listbox"]',
      ).find(scrollable) ?? null;
    };
    const scrollToFindOption = async (
      target: string,
      clicked: Set<HTMLElement>,
    ): Promise<HTMLElement | undefined> => {
      const scroller = scrollableOptionList();
      if (!scroller) return undefined;
      scroller.scrollTop = 0;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await wait(50);
        const found = findMatchingOption(optionPool(), target, clicked);
        if (found) return found;
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break;
        scroller.scrollTop = Math.min(
          scroller.scrollTop + Math.max(scroller.clientHeight, 40),
          scroller.scrollHeight,
        );
      }
      return undefined;
    };

    const restoreSearch = (input: HTMLInputElement, previous: string): void => {
      setNativeValue(input, previous);
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'deleteContentBackward',
      }));
    };

    const missing: string[] = [];
    const clicked = new Set<HTMLElement>();
    let searchInputUsed: HTMLInputElement | undefined;
    let searchBefore: string | undefined;
    let typedTarget: string | undefined;

    for (const target of targets) {
      // 已选中的项不重复点击，保证重复粘贴同一份数据时幂等。
      if (currentValues().includes(target)) {
        continue;
      }
      await ensureOpen();
      let option = await waitForOption(target, clicked);
      if (!option) {
        const input = searchInputUsed ?? searchInput();
        if (input) {
          searchInputUsed = input;
          searchBefore ??= input.value;
          typeSearch(input, target);
          typedTarget = target;
          option = await waitForOption(target, clicked);
        }
      }
      if (!option) {
        option = await scrollToFindOption(target, clicked);
      }
      if (!option) {
        missing.push(target);
        continue;
      }

      // 点击后回读验证：级联/树形下拉里同文本的父节点可能只是展开下一级，
      // 需要继续找同文本的其他候选，而不是误报成功。
      for (let attempt = 0; option && attempt < 6; attempt += 1) {
        clicked.add(option);
        clickOption(option);
        await wait(100);
        if (currentValues().includes(target)) {
          option = undefined;
          break;
        }
        const pool = optionPool();
        // 下拉已收起，视为已选中；最终值仍由填充后的统一回读校验。
        if (pool.length === 0) {
          option = undefined;
          break;
        }
        option = findMatchingOption(pool, target, clicked);
      }
      if (option) {
        missing.push(target);
      }
    }

    if (typedTarget && missing.includes(typedTarget) && searchInputUsed && searchBefore !== undefined) {
      restoreSearch(searchInputUsed, searchBefore);
    }

    // 单选点击选项后框架会自动收起；多选需要手动 toggle 收起。
    // 只有本次确实展开过才收起，避免把原本未展开的下拉点开。
    if (isMultipleSelect(root) && opened) {
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
        : querySelectorAllDeep<HTMLInputElement>(root, 'input')[0];
      if (input) {
        setNativeValue(input, values.join(','));
        dispatchValueEvents(input);
        return;
      }
    }

    throw new Error(`未找到下拉选项：${missing.join('、')}`);
  }
}
