import { describe, expect, it } from 'vitest';

import { canApplyPlanItem, describePlanRow, type OrganizePlanItem } from '../src/modules/bookmark-organizer/bookmark-plan';
import { collectRuleSignals } from '../src/modules/bookmark-organizer/bookmark-rules';
import { createBookmarkSnapshot } from '../src/modules/bookmark-organizer/bookmark-tree';

const planItem = (patch: Partial<OrganizePlanItem> = {}): OrganizePlanItem => ({
  bookmarkId: 'bookmark-1',
  title: '一嗨行政管理系统',
  url: 'https://app.mockplus.cn/project',
  urlFingerprint: 'https://app.mockplus.cn/project',
  host: 'app.mockplus.cn',
  fromPath: '书签栏 / 原型图 / 一嗨行政管理系统',
  fromRelativePath: '原型图/一嗨行政管理系统',
  suggestedPath: '设计文档',
  targetPath: '设计文档',
  classification: {
    purpose: 'design',
    project: 'general',
    environment: 'unknown',
    verdict: 'review',
    reason: '仅有弱线索（所在文件夹「原型图」提示设计文档），不会默认选入批次',
    evidence: ['所在文件夹「原型图」提示设计文档'],
    matchedUserRule: false,
    noAutoMove: false,
  },
  status: 'review',
  originalParentId: 'folder-1',
  originalIndex: 0,
  originalTitle: '一嗨行政管理系统',
  selected: false,
  ...patch,
});

describe('书签整理预览行状态', () => {
  it('有可移动目标时显示待采用，允许勾选和一键采用', () => {
    const item = planItem();
    expect(canApplyPlanItem(item)).toBe(true);
    expect(describePlanRow(item)).toMatchObject({
      badge: '有建议·待采用',
      badgeStatus: 'review',
      targetText: '书签栏 / 原型图 / 一嗨行政管理系统 → 设计文档',
      hint: null,
      selectable: true,
      canAdopt: true,
      showSelectionTag: false,
      stateText: '有建议·待采用；未选入批次',
    });
  });

  it('没有建议目标时区分保持原位，不提供无效果的勾选', () => {
    const item = planItem({ targetPath: null, suggestedPath: null });
    expect(canApplyPlanItem(item)).toBe(false);
    expect(describePlanRow(item)).toMatchObject({
      badge: '无建议·保持原位',
      targetText: '书签栏 / 原型图 / 一嗨行政管理系统 → 保持原位',
      hint: '展开本条，填写一个与当前位置不同的目标文件夹后，才能选入批次。',
      selectable: false,
      canAdopt: false,
      showSelectionTag: false,
      stateText: '无建议·保持原位；不可选入批次',
    });
  });

  it('目标与当前位置相同时按尾斜杠归一化并阻止空移动', () => {
    const item = planItem({ targetPath: '原型图/一嗨行政管理系统/', status: 'review' });
    expect(canApplyPlanItem(item)).toBe(false);
    expect(describePlanRow(item)).toMatchObject({
      badge: '目标在原位',
      targetText: '书签栏 / 原型图 / 一嗨行政管理系统 → 保持原位（目标与当前位置相同）',
      hint: '展开本条，填写一个与当前位置不同的目标文件夹后，才能选入批次。',
      selectable: false,
      canAdopt: false,
    });
  });

  it('采用建议后保留分类徽标，只增加选择状态', () => {
    const state = describePlanRow(planItem({ selected: true }));
    expect(state).toMatchObject({
      badge: '有建议·待采用',
      badgeStatus: 'review',
      selectable: true,
      canAdopt: false,
      showSelectionTag: true,
      stateText: '有建议·待采用；已选入批次',
    });
  });

  it('冲突项有目标时可人工采用，没有目标时提示指定目录', () => {
    expect(describePlanRow(planItem({ status: 'conflict' }))).toMatchObject({
      badge: '冲突·待采用',
      badgeStatus: 'conflict',
      selectable: true,
      canAdopt: true,
    });
    expect(describePlanRow(planItem({ status: 'conflict', targetPath: null }))).toMatchObject({
      badge: '冲突·待指定目录',
      targetText: '书签栏 / 原型图 / 一嗨行政管理系统 → 保持原位',
      selectable: false,
      canAdopt: false,
    });
  });

  it('固定项即使有目标也保持不可选，不显示指定目标提示', () => {
    const state = describePlanRow(planItem({ status: 'pinned' }));
    expect(canApplyPlanItem(planItem({ status: 'pinned' }))).toBe(false);
    expect(state).toMatchObject({
      badge: '已固定',
      badgeStatus: 'pinned',
      targetText: '书签栏 / 原型图 / 一嗨行政管理系统 → 保持原位（已固定）',
      selectable: false,
      canAdopt: false,
      showSelectionTag: false,
      hint: null,
    });
  });

  it('默认选中的确定项不重复显示采用标记，但仍可取消勾选', () => {
    expect(describePlanRow(planItem({
      status: 'move',
      selected: true,
      classification: { ...planItem().classification, verdict: 'certain' },
    }))).toMatchObject({
      badge: '确定',
      selectable: true,
      canAdopt: false,
      showSelectionTag: false,
      stateText: '确定；已选入批次',
    });
  });

  it('弱线索证据使用中文用途标签', () => {
    const signals = collectRuleSignals({
      title: '一嗨行政管理系统',
      url: 'https://app.mockplus.cn/project',
      folderNames: ['原型图'],
    }, []);
    expect(signals.map((signal) => signal.evidence)).toContain('所在文件夹「原型图」提示设计文档');
    expect(JSON.stringify(signals)).not.toContain('提示design');
  });

  it('根节点标题为空时展示路径不显示根节点 ID', () => {
    const snapshot = createBookmarkSnapshot([{
      id: '0', title: '', syncing: false, children: [{
        id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', syncing: false, children: [{
          id: 'bookmark-1', title: 'DEMO-网关', url: 'https://example.com/demo', syncing: false,
        }],
      }],
    }]);
    expect(snapshot.nodes['bookmark-1'].path).toBe('书签栏 / DEMO-网关');
    expect(snapshot.nodes['bookmark-1'].path).not.toContain('0 /');
  });
});
