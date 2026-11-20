import { closestComposed, composedParent, containsComposed, querySelectorAllDeep } from './composed-dom';
import { CONTROL_COLLECT_SELECTOR } from './control-selectors';
import { isRendered } from './visibility';

export interface RepeatableTable {
  rows: HTMLTableRowElement[];
  addButton?: HTMLButtonElement;
}

const ADD_LABEL = /^(?:(?:新增|添加)(?:一行|行|参数)?|add(?:row)?)$/i;
const ACTION_SELECTOR = 'button, [role="button"], a[href]';

const addActionsIn = (region: HTMLElement): HTMLElement[] => {
  const ownAction = region.matches(ACTION_SELECTOR) ? [region] : [];
  return [...ownAction, ...querySelectorAllDeep(region, ACTION_SELECTOR)].filter((action) => {
    const label = (action.getAttribute('aria-label') || action.textContent || '').replace(/[\s+＋]/g, '');
    return ADD_LABEL.test(label) && !closestComposed(action, 'tbody, tfoot') && isRendered(action);
  });
};

/** 只在与表格同组的容器内找加行入口，遇到其他表格或独立表单字段即停止向外查找。 */
const localAddActions = (table: HTMLTableElement, scope: HTMLElement): HTMLElement[] => {
  const form = closestComposed(table, 'form, [role="form"], .ant-form, .el-form');
  const adjacent: HTMLElement[] = [];
  for (let region: HTMLElement | null = table; region; region = composedParent(region)) {
    if (region.matches('body, main') || !containsComposed(scope, region)) break;
    if (querySelectorAllDeep(region, 'table').some((other) => other !== table && isRendered(other))) break;
    if (querySelectorAllDeep(region, CONTROL_COLLECT_SELECTOR)
      .some((control) => !containsComposed(table, control) && isRendered(control))) break;

    const actions = addActionsIn(region);
    if (actions.length > 0) return actions;
    if (region === scope || region === form) break;

    // 表格和按钮也可能直接平铺在表单内，此时只接受表格前紧邻的工具栏。
    if (adjacent.length === 0) {
      for (let sibling = region.previousElementSibling; sibling instanceof HTMLElement; sibling = sibling.previousElementSibling) {
        if (!containsComposed(scope, sibling) || sibling.matches(`table, ${CONTROL_COLLECT_SELECTOR}`) ||
          sibling.querySelector(`table, ${CONTROL_COLLECT_SELECTOR}`)) break;
        const candidates = addActionsIn(sibling);
        if (candidates.length === 0) break;
        adjacent.push(...candidates);
      }
    }
  }
  return adjacent;
};

export const findRepeatableTables = (scope: HTMLElement): Map<string, RepeatableTable> => {
  const tables = new Map<string, RepeatableTable>();
  const seen = new Set<string>();

  for (const table of querySelectorAllDeep<HTMLTableElement>(scope, 'table')) {
    // 只处理列与单元格一一对应的表格。合并列、固定表头拆表等结构交给普通字段识别。
    if (!isRendered(table) || table.tHead?.rows.length !== 1 || table.tBodies.length !== 1) continue;
    const headers = [...table.tHead.rows[0].cells];
    if (headers.length === 0 || headers.some((cell) => cell.colSpan !== 1 || cell.rowSpan !== 1)) continue;
    const labels = headers.map((cell) => cell.textContent?.trim().replace(/\s+/g, ' ') ?? '');
    if (!labels.some(Boolean)) continue;
    const signature = JSON.stringify(labels);
    if (seen.has(signature)) {
      tables.delete(signature);
      continue;
    }
    seen.add(signature);

    const actions = localAddActions(table, scope);
    if (actions.length === 0) continue;
    const [button] = actions;
    const addButton = actions.length === 1 && button instanceof HTMLButtonElement && button.type === 'button' &&
      !button.matches(':disabled') && !closestComposed(button, '[aria-disabled="true"]') ? button : undefined;
    const rows = [...table.tBodies[0].rows].filter((row) =>
      row.cells.length === headers.length && [...row.cells].every((cell) => cell.colSpan === 1 && cell.rowSpan === 1) &&
      row.getBoundingClientRect().height > 0 && isRendered(row),
    );
    tables.set(signature, { rows, addButton });
  }

  return tables;
};
