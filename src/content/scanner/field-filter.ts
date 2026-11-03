import {
  CUSTOM_SELECT_INPUT_HOST_SELECTOR,
  DIALOG_SCOPE_SELECTOR,
  NATIVE_SELECT_WRAPPER_SELECTOR,
  VISUALLY_REPLACED_SELECTOR,
} from './control-selectors';
import { closestComposed, composedParent, querySelectorAllDeep } from './composed-dom';
import { resolveLabel } from './label-resolver';
import { isRendered } from './visibility';

export type FormControlElement = HTMLElement;

export interface ScanContext {
  scope: HTMLElement;
}

export interface FieldFilter {
  shouldInclude(element: FormControlElement, context: ScanContext): boolean;
}

const sensitivePattern =
  /password|passwd|pwd|密码|验证码|校验码|短信码|verification.?code|verify.?code|sms.?code|one.?time.?code|\botp\b|信用卡|银行卡|card.?number|\bcc-|\bcvv\b|\bcvc\b|\bsecret\b|(?:client|api|app|access|auth)[\s_-]*secret|secret[\s_-]*(?:key|value)|api.?key|access.?key|密钥|令牌/i;
const credentialTokenPattern =
  /(?:api|access|auth|refresh|session|bearer|csrf|secret)[\s_-]*token|token[\s_-]*(?:key|secret|value)|\btoken\b(?!\s*(?:count|limit|usage|budget|size|length|数量|上限|下限|用量|总数|余额))/i;
const isSensitiveText = (value: string): boolean => sensitivePattern.test(value) || credentialTokenPattern.test(value);

/** 登录/注册表单中账号类字段的语义特征。 */
const accountPattern = /(?:^|[\s_-])(?:user.?name|user.?id|account(?:.?id|.?name)?|login(?:.?user|.?id|.?name)?|logon|email)(?=$|[\s_-])|账号|用户名|手机|邮箱/i;
const businessMaskedLabelPattern = /联系电话|手机号|身份证|证件|收款账户|银行账户|phone|mobile|telephone/i;

/**
 * 登录/注册表单的控件数上限。登录表单通常只有账号、密码、验证码、记住我等寥寥几个控件；
 * 内嵌脱敏字段（Input.Password 展示手机号/证件号）的业务表单控件远不止这些，
 * 用数量阈值把两类场景区分开，避免误伤业务表单。
 */
const LOGIN_FORM_CONTROL_LIMIT = 6;
const irrelevantContainerPattern = /global.?search|sidebar.?search|nav.?search|pagination/i;
const queryFormContainerPattern = /filter.?form|query.?form/i;

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

/** 只检查祖先，避免把控件自身的 hidden/aria-hidden 当成不可见（替身控件需要单独判断）。 */
const hasHiddenAncestor = (element: FormControlElement): boolean => {
  for (let current = composedParent(element); current; current = composedParent(current)) {
    if (current.matches('[hidden], [aria-hidden="true"]')) {
      return true;
    }
  }
  return false;
};

const isNativeToggle = (element: FormControlElement): element is HTMLInputElement =>
  element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio');

/**
 * 查找原生 select 的可见替身容器。
 * select2/chosen/choices 把替身放在原 select 的兄弟位置，bootstrap-select/tom-select 包在祖先上，
 * 两种情况都要覆盖；相邻查找遇到另一个 select 就停止，避免匹配到别处的下拉。
 */
export const findNativeSelectWrapper = (select: HTMLSelectElement): HTMLElement | null => {
  const ancestor = closestComposed<HTMLElement>(select, NATIVE_SELECT_WRAPPER_SELECTOR);
  if (ancestor && ancestor !== select) {
    return ancestor;
  }
  const isWrapper = (node: Element | null): node is HTMLElement =>
    node instanceof HTMLElement && node !== select && node.matches(NATIVE_SELECT_WRAPPER_SELECTOR);
  for (let sibling = select.nextElementSibling, depth = 0; sibling && depth < 3; sibling = sibling.nextElementSibling, depth += 1) {
    if (isWrapper(sibling)) return sibling;
    if (sibling instanceof HTMLSelectElement) break;
  }
  for (let sibling = select.previousElementSibling, depth = 0; sibling && depth < 3; sibling = sibling.previousElementSibling, depth += 1) {
    if (isWrapper(sibling)) return sibling;
    if (sibling instanceof HTMLSelectElement) break;
  }
  return null;
};

/** 原生控件被隐藏时，用来判断它是否仍由某个可见的替身承载。 */
const replacementOf = (element: FormControlElement): HTMLElement | null => {
  if (element instanceof HTMLSelectElement) {
    return findNativeSelectWrapper(element);
  }
  if (isNativeToggle(element)) {
    const container = closestComposed(element, VISUALLY_REPLACED_SELECTOR);
    if (container && container !== element) {
      return container;
    }
    // <input type="checkbox" hidden><label for="..."> 的常见写法：替身是与控件关联的 label。
    if (element.id) {
      const root = element.getRootNode();
      const labelRoot = root instanceof Document || root instanceof ShadowRoot ? root : document;
      const label = labelRoot.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`);
      if (label) return label;
    }
    return null;
  }
  if (element instanceof HTMLInputElement) {
    const host = closestComposed(element, CUSTOM_SELECT_INPUT_HOST_SELECTOR);
    return host && host !== element ? host : null;
  }
  return null;
};

const isVisible = (element: FormControlElement): boolean => {
  if (hasHiddenAncestor(element)) {
    return false;
  }
  const style = getComputedStyle(element);
  const replacement = replacementOf(element);
  const ariaHidden = element.getAttribute('aria-hidden') === 'true';
  // 替身控件自身常带 aria-hidden（select2 会把可访问性交给替身），但 ARIA 复选控件背后的原生 input
  // 也会用它避免重复朗读；后者已有 role=checkbox/radio 的替身单独采集，不能再重复收录。
  if (ariaHidden && !(element instanceof HTMLSelectElement)) {
    return false;
  }
  const selfHidden =
    element.hidden || ariaHidden || style.display === 'none' ||
    style.visibility === 'hidden' || style.opacity === '0';
  if (selfHidden) {
    if (!replacement || !isRendered(replacement)) {
      return false;
    }
    // 复选/单选/下拉的原生控件常被 display:none 或 opacity:0 隐藏，可见替身才是用户看到的控件；
    // 普通文本框只在自定义下拉容器内允许 opacity:0（显示值由容器承载）。
    if (isNativeToggle(element) || element instanceof HTMLSelectElement) {
      return true;
    }
    return style.opacity === '0' && style.display !== 'none' && style.visibility !== 'hidden';
  }
  // display:none 子树内元素的计算样式仍是自身原值（display 不可继承），
  // 必须确认真的渲染出了盒子，否则隐藏页签/隐藏路由里的控件会混进扫描结果。
  // 被框架视觉替换的原生控件（自定义下拉/复选框内部）尺寸恒为 0，属正常形态。
  return isRendered(element) || Boolean(
    replacement && isRendered(replacement) &&
    element.parentElement && isRendered(element.parentElement),
  );
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
 * password 类型逐字段判断：descriptor 或页面 label 命中敏感语义（密码/验证码/令牌等）时排除；
 * 没有可解释标签时默认排除。label 为业务语义（联系电话、身份证号、收款账户等）的脱敏输入框照常采集。
 */
const isSensitivePasswordField = (element: FormControlElement): boolean => {
  if (isSensitiveText(descriptor(element))) {
    return true;
  }
  const label = safeResolveLabel(element);
  return !label || isSensitiveText(label);
};

/**
 * 登录/注册场景识别：少量账号字段与 password 输入同时出现时，
 * 即使密码框缺少敏感名称或标签，也只排除密码框。账号字段仍可复制；
 * 业务表单中用 Input.Password 展示的非密码字段继续按字段语义判断。
 */
const isLoginPasswordField = (element: FormControlElement): boolean => {
  if (!(element instanceof HTMLInputElement) || element.type !== 'password') {
    return false;
  }
  if (businessMaskedLabelPattern.test(safeResolveLabel(element) ?? '')) {
    return false;
  }
  const form = closestComposed<HTMLFormElement>(element, 'form');
  if (!form) {
    return false;
  }
  if (querySelectorAllDeep(form, 'input[type="password"]').length === 0) {
    return false;
  }
  if (querySelectorAllDeep(form, 'input, textarea, select').length > LOGIN_FORM_CONTROL_LIMIT) {
    return false;
  }
  return querySelectorAllDeep<HTMLInputElement>(form, 'input').some((input) => {
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
      if (ignoredTypes.has(element.type)) {
        return false;
      }
      if (element.type === 'password' && isSensitivePasswordField(element)) {
        return false;
      }
    }

    if (isSensitiveText(descriptor(element)) || isSensitiveText(safeResolveLabel(element) ?? '')) {
      return false;
    }

    if (isLoginPasswordField(element)) {
      return false;
    }

    const excludedArea = closestComposed(element, 'header, nav, [role="search"], [role="navigation"]');
    if (excludedArea) {
      return false;
    }

    let container: HTMLElement | null = element;
    const boundary = composedParent(scope);
    while (container && container !== boundary) {
      const containerDescriptor = `${container.id} ${container.className}`;
      // 编辑弹窗可能复用查询表单组件，不能仅凭 query-form/filter-form 类名排除业务字段。
      if (
        irrelevantContainerPattern.test(containerDescriptor) ||
        (queryFormContainerPattern.test(containerDescriptor) && !scope.matches(DIALOG_SCOPE_SELECTOR))
      ) {
        return false;
      }
      container = composedParent(container);
    }
    return true;
  }
}
