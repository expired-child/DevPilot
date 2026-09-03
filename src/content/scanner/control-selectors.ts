/**
 * 控件选择器单一真源。
 *
 * 各 UI 框架的 DOM 结构差异很大，过去这些类名散落在 scanner 与 adapters 的多处，
 * 新增一个框架要同步改 5 个地方（iView 就是这样被漏掉的）。
 * 现在统一收敛到此文件：新增框架支持只需在对应数组里追加类名。
 */

const join = (selectors: string[]): string => selectors.join(',');

/** 各框架「自定义下拉」组件的根节点（非原生 select）。 */
export const CUSTOM_SELECT_ROOT_SELECTOR = join([
  '.ant-select',
  '.el-select',
  '.ivu-select',
  '.MuiAutocomplete-root',
  '.MuiSelect-root',
  '.mat-mdc-select',
  '.mat-select',
  '.n-select',
  '.arco-select',
  '.p-dropdown',
  '.p-select',
  '.v-select',
  '.v-autocomplete',
  '.v-combobox',
  '.mantine-Select-root',
  '.mantine-MultiSelect-root',
  '.semi-select',
  '.t-select',
  '.q-select',
  '[class*="react-select__control"]',
]);

/** 多选下拉的标记类名：命中即视为可多选，读取值时统一返回数组。 */
const MULTIPLE_CLASS_TOKENS = [
  'ant-select-multiple',
  'v-select--multiple',
  'semi-select-multiple',
  't-select--multiple',
  'mantine-MultiSelect-root',
  'is-multiple',
  'multiple',
];

/** 通用组合框：无框架类名的下拉（含 Radix/shadcn 的 Select trigger）。 */
export const COMBOBOX_SELECTOR = '[role="combobox"]';

/** 下拉根节点或组合框，用于判断「这个 input 属于某个下拉，不是普通文本框」。 */
export const CUSTOM_SELECT_INPUT_HOST_SELECTOR = join([CUSTOM_SELECT_ROOT_SELECTOR, COMBOBOX_SELECTOR]);

/** 展开下拉时需要点击的触发区域。 */
export const DROPDOWN_TRIGGER_SELECTOR = join([
  '.ant-select-selector',
  '.ant-select-selection',
  '.el-input',
  '.ivu-select-selection',
  '.MuiSelect-select',
  '.mat-mdc-select-trigger',
  '.mat-select-trigger',
  '.v-field__input',
  '.v-select__menu-icon',
  '.semi-select-selection',
  '.t-input__inner',
  '.q-field__native',
  COMBOBOX_SELECTOR,
]);

/** 下拉内部展示当前选中文本的元素。 */
export const SELECTED_VALUE_SELECTOR = join([
  '.ant-select-selection-selected-value',
  '.ant-select-selection-item',
  '.ant-select-selection__choice__content',
  '.el-select__selected-item',
  '.el-select__tags-text',
  '.ivu-select-selected-item',
  '.MuiSelect-select',
  '.mat-mdc-select-value-text',
  '.mat-select-value-text',
  '.n-base-selection-label__render-label',
  '.arco-select-view-value',
  '.p-dropdown-label',
  '.p-select-label',
  '.v-select__selection-text',
  '.semi-select-selection-content',
  '[class*="singleValue"]',
  '[class*="multi-value__label"]',
]);

/** 展开后可见的可点击选项。 */
export const DROPDOWN_OPTION_SELECTOR = join([
  '.ant-select-dropdown:not(.ant-select-dropdown-hidden) [role="option"]',
  '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item',
  '.el-select-dropdown:not([style*="display: none"]) .el-select-dropdown__item',
  '.el-popper:not([style*="display: none"]) [role="option"]',
  '.ivu-select-dropdown:not([style*="display: none"]) .ivu-select-item',
  '[role="listbox"] [role="option"]:not([aria-disabled="true"])',
  // 部分框架的选项没有 role=option，用类名兜底；必须限定在弹出层容器内，
  // 否则会误点页面上同文本的普通列表项（如侧边栏导航）。
  '.v-overlay__content .v-list-item',
  '.mantine-Select-dropdown .mantine-Select-option',
  '.semi-select-dropdown .semi-select-option',
  '.t-select__list .t-select-option',
  '.q-menu .q-item[role="option"]',
]);

/** 选项所在的弹出层容器，用于判断弹出层是否真的可见。 */
export const DROPDOWN_POPUP_SELECTOR = join([
  '.ant-select-dropdown',
  '.el-select-dropdown',
  '.ivu-select-dropdown',
  '.v-overlay__content',
  '.mantine-Select-dropdown',
  '.semi-select-dropdown',
  '.t-select__list',
  '.q-menu',
  '[role="listbox"]',
]);

/** 判断下拉是否为多选：多选时读取值统一返回数组。 */
export const isMultipleSelect = (root: HTMLElement): boolean =>
  [...root.classList].some((token) => MULTIPLE_CLASS_TOKENS.includes(token)) ||
  root.getAttribute('aria-multiselectable') === 'true';

/** 表示弹出层被隐藏的属性/类名。 */
export const DROPDOWN_HIDDEN_SELECTOR = '[hidden], .ant-select-dropdown-hidden';

/**
 * 自研下拉的通用选项（已知框架选择器之外的兜底）。
 * 类名 token 覆盖内部组件库 teleport 出来的选项节点，如 ehi-select-option。
 */
export const GENERIC_OPTION_SELECTOR = join([
  '[role="option"]:not([aria-disabled="true"])',
  '[role="listbox"] li',
  '[class*="option" i]',
  '[class*="select-item" i]',
  '[class*="dropdown-item" i]',
]);

/**
 * 通用选项的浮层归属判断：要求选项挂在某个浮层容器内，
 * 避免把页面上普通的列表项（导航菜单等）误当成下拉选项。
 */
export const GENERIC_POPUP_SELECTOR = join([
  '[role="listbox"]',
  '[role="menu"]',
  '[class*="popper" i]',
  '[class*="popup" i]',
  '[class*="dropdown" i]',
  '[class*="select-menu" i]',
  '[class*="select-options" i]',
  '[class*="overlay" i]',
]);

/** 开关（Switch/Toggle）组件的根节点。 */
export const SWITCH_ROOT_SELECTOR = join([
  '.ivu-switch',
  '.ant-switch',
  '.el-switch',
  '.n-switch',
  '.arco-switch',
  '.p-inputswitch',
  '[role="switch"]',
]);

/** 无原生 input 的 ARIA 复选控件（Radix/shadcn 的 Checkbox）。 */
export const ARIA_CHECKBOX_SELECTOR = '[role="checkbox"]';

/** 无原生 input 的 ARIA 单选控件（Radix/shadcn 的 RadioGroupItem）。 */
export const ARIA_RADIO_SELECTOR = '[role="radio"]';

/** ARIA 开关型控件合集。 */
export const ARIA_TOGGLE_SELECTOR = join([ARIA_CHECKBOX_SELECTOR, ARIA_RADIO_SELECTOR]);

/** ARIA 单选组容器。 */
export const ARIA_RADIO_GROUP_SELECTOR = '[role="radiogroup"]';

/**
 * 被框架「视觉替换」的原生控件所在容器。
 * 这些容器内部的原生 input 虽然不可见（opacity:0 / 尺寸为 0），但仍是有效控件，不能按不可见剔除。
 */
export const VISUALLY_REPLACED_SELECTOR = join([
  'label',
  CUSTOM_SELECT_ROOT_SELECTOR,
  COMBOBOX_SELECTOR,
  SWITCH_ROOT_SELECTOR,
  ARIA_TOGGLE_SELECTOR,
  '[class*="checkbox" i]',
  '[class*="radio" i]',
]);

/** 日期/时间选择控件根节点。 */
export const DATE_PICKER_ROOT_SELECTOR = join([
  '.ant-picker',
  '.el-date-editor',
  '.ivu-date-picker',
  '.arco-picker',
  '.n-date-picker',
  '.p-datepicker',
  '.mat-datepicker-input-container',
  '[class*="date-picker" i]',
  '[class*="datepicker" i]',
  '[class*="time-picker" i]',
  '[class*="datetime" i]',
  '[class*="picker" i]',
]);

/**
 * 未知自研下拉的通用语义：ARIA 弹出层属性。
 * 上面的框架类名表覆盖不到内部组件库（如自研 SearchSelect）时靠它兜底。
 */
export const GENERIC_DROPDOWN_ARIA_SELECTOR = join([
  '[aria-haspopup="listbox"]',
  '[aria-haspopup="menu"]',
  '[aria-expanded]',
  COMBOBOX_SELECTOR,
]);

/**
 * 通用下拉容器的类名 token。要求整词匹配（允许 - 连接的词缀），
 * 避免 unselectable、selection-focused 这类包含 select 的无关类名被误判。
 */
const DROPDOWN_CLASS_TOKEN =
  /^(?:[a-z0-9]+-)?(?:select|selector|dropdown|combobox|autocomplete)(?:-[a-z0-9]+)*$/i;

export const matchesDropdownClassToken = (element: HTMLElement): boolean =>
  Boolean(element?.classList) && [...element.classList].some((token) => DROPDOWN_CLASS_TOKEN.test(token));

/** 通用下拉兜底探测的最大祖先层数：再往上就是整个表单容器，不能当成下拉。 */
export const GENERIC_DROPDOWN_MAX_DEPTH = 3;

/** 扫描时用于收集全部候选控件的选择器。 */
export const CONTROL_COLLECT_SELECTOR = join([
  'input',
  'textarea',
  'select',
  CUSTOM_SELECT_ROOT_SELECTOR,
  COMBOBOX_SELECTOR,
  SWITCH_ROOT_SELECTOR,
  ARIA_TOGGLE_SELECTOR,
]);

/** 表单域容器，用于在找不到 label 时向祖先寻找相邻文本。 */
export const FIELD_CONTAINER_SELECTOR = join([
  '.form-item',
  '.ant-form-item',
  '.el-form-item',
  '[class*="formItem"]',
  '[class*="field"]',
]);

/**
 * 打开的弹窗/抽屉容器。弹窗打开时用户操作的就是它，即使背后的页面控件更多，
 * 扫描作用域也应优先选弹窗（见 form-scanner 的 rankScopes 加倍逻辑）。
 * 框架专属类名之外保留通配匹配，覆盖自定义弹窗实现。
 */
export const DIALOG_SCOPE_SELECTOR = join([
  '[role="dialog"]',
  'dialog[open]',
  '[aria-modal="true"]',
  '.ant-modal',
  '.ant-drawer-content',
  '.el-dialog',
  '.el-drawer',
  '.arco-modal',
  '.ivu-modal',
  '.semi-modal',
  '.t-dialog',
  '[class*="modal" i]',
  '[class*="dialog" i]',
  '[class*="drawer" i]',
]);

/** 表单作用域候选：优先在真正的表单/弹窗内扫描。 */
export const FORM_SCOPE_SELECTOR = join([
  'form',
  DIALOG_SCOPE_SELECTOR,
  'main',
  '.ant-form',
  '.el-form',
  '[class*="form"]',
]);
