import { CUSTOM_SELECT_INPUT_HOST_SELECTOR, VISUALLY_REPLACED_SELECTOR } from './control-selectors';
import { resolveLabel } from './label-resolver';

export type FormControlElement = HTMLElement;

export interface ScanContext {
  scope: HTMLElement;
}

export interface FieldFilter {
  shouldInclude(element: FormControlElement, context: ScanContext): boolean;
}

const sensitivePattern =
  /password|passwd|pwd|密码|验证码|校验码|短信码|信用卡|银行卡|card.?number|\bcc-|one-time-code|\bcvv\b|\bcvc\b|token|secret|api.?key|access.?key|密钥|令牌/i;

/** 登录/注册表单中账号类字段的语义特征。 */
const accountPattern = /user.?name|account|login|logon|账号|用户名|手机|邮箱|email/i;

/**
 * 登录/注册表单的控件数上限。登录表单通常只有账号、密码、验证码、记住我等寥寥几个控件；
 * 内嵌脱敏字段（Input.Password 展示手机号/证件号）的业务表单控件远不止这些，
 * 用数量阈值把两类场景区分开，避免误伤业务表单。
 */
const LOGIN_FORM_CONTROL_LIMIT = 6;
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
  const visuallyReplacedControl = element.closest(VISUALLY_REPLACED_SELECTOR);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    (style.opacity === '0' && !visuallyReplacedControl)
  ) {
    return false;
  }
  // display:none 子树内元素的计算样式仍是自身原值（display 不可继承），
  // 必须确认真的渲染出了盒子，否则隐藏页签/隐藏路由里的控件会混进扫描结果。
  // 被框架视觉替换的原生控件（自定义下拉/复选框内部）尺寸恒为 0，属正常形态。
  if (visuallyReplacedControl) {
    return true;
  }
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility();
  }
  if (typeof element.getClientRects === 'function') {
    return element.getClientRects().length > 0;
  }
  return element.offsetWidth > 0 || element.offsetHeight > 0;
};

/**
 * 浏览器外（单元测试）没有 document，label 解析直接跳过；
 * 浏览器内解析失败也不影响主流程，按无 label 处理。
 */
const safeResolveLabel = (element: FormControlElement): string | undefined => {
  if (typeof document === 'undefined') {
    return undefined;
  }
  try {
    return resolveLabel(element);
  } catch {
    return undefined;
  }
};

/**
 * password 类型逐字段判断：descriptor 或页面 label 命中敏感语义（密码/验证码/令牌等）才排除；
 * label 为业务语义（联系电话、身份证号、收款账户等）的脱敏输入框照常采集。
 */
const isSensitivePasswordField = (element: FormControlElement): boolean => {
  if (sensitivePattern.test(descriptor(element))) {
    return true;
  }
  const label = safeResolveLabel(element);
  return Boolean(label && sensitivePattern.test(label));
};

/**
 * 登录/注册场景识别：form 内同时存在 password 输入与账号类字段、且控件总数很少时，
 * 整个表单不采集（隐私承诺）。取代过去「含 password 即排除全表」的连坐规则——
 * 那条规则会把内嵌 Input.Password 脱敏字段的业务表单（往往几十个控件）整体误杀，
 * 进而导致扫描作用域逃逸到弹窗背后的列表页，抓回不存在的幽灵字段。
 */
const isLoginFormControl = (element: FormControlElement): boolean => {
  const form = element.closest('form');
  if (!form || typeof form.querySelector !== 'function' || typeof form.querySelectorAll !== 'function') {
    return false;
  }
  if (!form.querySelector('input[type="password"]')) {
    return false;
  }
  if (form.querySelectorAll('input, textarea, select').length > LOGIN_FORM_CONTROL_LIMIT) {
    return false;
  }
  return [...form.querySelectorAll<HTMLInputElement>('input')].some((input) => {
    const autocomplete = input.getAttribute('autocomplete');
    return autocomplete === 'username' || accountPattern.test(descriptor(input));
  });
};

export class DefaultFieldFilter implements FieldFilter {
  shouldInclude(element: FormControlElement, { scope }: ScanContext): boolean {
    if (!isVisible(element)) {
      return false;
    }

    if (element instanceof HTMLInputElement) {
      const ignoredTypes = new Set(['hidden', 'file', 'button', 'submit', 'reset', 'image']);
      const customSelectInput = Boolean(element.closest(CUSTOM_SELECT_INPUT_HOST_SELECTOR));
      if (ignoredTypes.has(element.type) || (element.type === 'search' && !customSelectInput)) {
        return false;
      }
      if (element.type === 'password' && isSensitivePasswordField(element)) {
        return false;
      }
    }

    if (sensitivePattern.test(descriptor(element))) {
      return false;
    }

    if (isLoginFormControl(element)) {
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
