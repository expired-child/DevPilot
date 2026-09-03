/**
 * React 受控组件内部值兜底。
 *
 * 自研组件常常把真实值保存在 React 内部，DOM 上既没有 value 属性也没有可见文本
 * （例如内部下拉只在 fiber 里保存选中项）。此时从元素上的 React 内部键读取，
 * 与组件外层封装了几层无关。Vue 同理可挂 __vue__，但当前遇到的页面都是 React，
 * 这里只做 React 分支，保持实现最小。
 */

const REACT_PROPS_KEY = /^__reactProps\$/;
const REACT_FIBER_KEY = /^__reactFiber\$/;

const stringify = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
};

const reactProps = (element: HTMLElement): Record<string, unknown> | undefined => {
  const key = Object.keys(element).find((name) => REACT_PROPS_KEY.test(name));
  if (key) {
    return element[key as keyof HTMLElement] as unknown as Record<string, unknown>;
  }
  const fiberKey = Object.keys(element).find((name) => REACT_FIBER_KEY.test(name));
  const fiber = fiberKey
    ? (element[fiberKey as keyof HTMLElement] as unknown as { memoizedProps?: Record<string, unknown> })
    : undefined;
  return fiber?.memoizedProps;
};

/** 读取 React 内部受控值；没有可读值时返回 undefined，由调用方决定回退策略。 */
export const readReactValue = (element: HTMLElement): string | undefined => {
  const props = reactProps(element);
  if (!props) {
    return undefined;
  }
  const value = stringify(props.value);
  if (value !== undefined && value !== '') {
    return value;
  }
  return stringify(props.defaultValue);
};

/** 读取 React 内部的选中状态（无原生 checked 的自研复选/单选）。 */
export const readReactChecked = (element: HTMLElement): boolean | undefined => {
  const props = reactProps(element);
  const checked = props?.checked;
  return typeof checked === 'boolean' ? checked : undefined;
};
