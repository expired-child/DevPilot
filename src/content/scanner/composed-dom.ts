/** 只穿透页面开放的 ShadowRoot；关闭的根无法从内容脚本访问。 */
export const querySelectorAllDeep = <T extends HTMLElement = HTMLElement>(scope: ParentNode, selector: string): T[] => {
  const result: T[] = [];
  const seen = new Set<Element>();
  const visitChildren = (root: ParentNode): void => {
    for (const child of root.children) visit(child);
  };
  const visit = (element: Element): void => {
    if (seen.has(element)) return;
    seen.add(element);
    if (element instanceof HTMLElement && element.matches(selector)) result.push(element as T);
    if (element.shadowRoot) visitChildren(element.shadowRoot);
    if (element instanceof HTMLSlotElement) {
      for (const assigned of element.assignedElements({ flatten: true })) visit(assigned);
    }
    visitChildren(element);
  };
  if (scope instanceof Element && scope.shadowRoot) visitChildren(scope.shadowRoot);
  visitChildren(scope);
  return result;
};

export const composedParent = (element: Element): HTMLElement | null => {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
};

export const closestComposed = <T extends HTMLElement = HTMLElement>(element: Element, selector: string): T | null => {
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (current.matches(selector)) return current as T;
  }
  return null;
};

export const containsComposed = (scope: Element, element: Element): boolean => {
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (current === scope) return true;
  }
  return false;
};

export const deepActiveElement = (doc: Document): Element | null => {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
};
