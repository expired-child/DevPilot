/**
 * 文档级作用域注册表：给候选表单容器分配仅当前文档有效的标识，
 * 让填充消息能找回扫描时的同一个作用域，即使同页多个表单字段和值完全相同。
 * 内容脚本随文档销毁，注册表也随之释放。
 */
const elementIds = new WeakMap<HTMLElement, string>();
const elementsById = new Map<string, WeakRef<HTMLElement>>();
let counter = 0;

export const scopeIdOf = (element: HTMLElement): string => {
  let id = elementIds.get(element);
  if (!id) {
    counter += 1;
    id = `scope-${counter}`;
    elementIds.set(element, id);
    elementsById.set(id, new WeakRef(element));
  }
  return id;
};

export const scopeElement = (id: string): HTMLElement | undefined => {
  const element = elementsById.get(id)?.deref();
  if (!element) elementsById.delete(id);
  return element;
};
