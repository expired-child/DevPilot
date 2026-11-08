import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookmarkOrganizeCoordinator } from '../src/background/bookmark-coordinator';
import { registerBookmarkAutoOrganize } from '../src/background/bookmark-auto-organize';
import { ChromeOrganizerRepository, defaultOrganizerState, ORGANIZER_STORAGE_KEY } from '../src/modules/bookmark-organizer/bookmark-organizer-repository';
import { BOOKMARK_AI_CONFIG_KEY, saveAiConfig, loadAiConfig } from '../src/modules/bookmark-organizer/bookmark-ai-config';

function event<T extends unknown[]>() {
  const listeners: Array<(...args: T) => void> = [];
  return { addListener: (fn: (...args: T) => void) => listeners.push(fn), fire: (...args: T) => listeners.forEach((fn) => fn(...args)) };
}
function setup() {
  const data: Record<string, unknown> = { [ORGANIZER_STORAGE_KEY]: defaultOrganizerState() };
  type Node = chrome.bookmarks.BookmarkTreeNode;
  const nodes: Record<string, Node> = {
    root: { syncing: false, id: 'root', title: '', children: [] },
    bar: { syncing: false, id: 'bar', title: '书签栏', parentId: 'root', children: [] },
    a: { syncing: false, id: 'a', title: 'MySQL 事务指南', parentId: 'bar', index: 0, url: 'https://example.com/mysql' },
  };
  const children = (parentId: string) => Object.values(nodes).filter((n) => n.parentId === parentId).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const tree = (id: string): Node => ({ ...nodes[id], ...(!nodes[id].url ? { children: children(id).map((n) => tree(n.id)) } : {}) });
  const onCreated = event<[string, Node]>();
  const onChanged = event<[string, object]>();
  const onMoved = event<[string, object]>();
  const onRemoved = event<[string, object]>();
  const onImportBegan = event<[]>();
  const onImportEnded = event<[]>();
  const onAlarm = event<[{ name: string }]>();
  let nextId = 0;
  const api = {
    getTree: async () => [tree('root')],
    get: async (id: string) => { if (!nodes[id]) throw new Error('not found'); return [{ ...nodes[id] }]; },
    getChildren: async (id: string) => children(id),
    create: vi.fn(async (input: { title?: string; parentId?: string; url?: string; index?: number }) => {
      const id = `new-${++nextId}`;
      const n = { syncing: false, id, title: input.title ?? '', parentId: input.parentId ?? 'bar', url: input.url, index: input.index ?? children(input.parentId ?? 'bar').length };
      nodes[id] = n;
      onCreated.fire(id, n);
      return n;
    }),
    move: vi.fn(async (id: string, dest: { parentId?: string; index?: number }) => {
      nodes[id] = { ...nodes[id], ...dest }; onMoved.fire(id, {}); return nodes[id];
    }),
    remove: vi.fn(async (id: string) => { if (children(id).length) throw new Error('not empty'); delete nodes[id]; onRemoved.fire(id, {}); }),
    onCreated, onChanged, onMoved, onRemoved, onImportBegan, onImportEnded,
    onChildrenReordered: event<[string, { childIds: string[] }]>(),
  };
  vi.stubGlobal('chrome', {
    bookmarks: api,
    permissions: { contains: async () => true },
    storage: { local: {
      get: async (key: string) => structuredClone({ [key]: data[key] }),
      set: async (value: Record<string, unknown>) => Object.assign(data, structuredClone(value)),
      remove: async (key: string) => { delete data[key]; },
    } },
    alarms: { create: async () => {}, onAlarm },
  });
  const coordinator = new BookmarkOrganizeCoordinator(new ChromeOrganizerRepository());
  const enable = () => {
    data[ORGANIZER_STORAGE_KEY] = { ...defaultOrganizerState(), settings: { automationVersion: 2, aiAutoPlaceEnabled: true, autoArchiveEnabled: false } };
    data[BOOKMARK_AI_CONFIG_KEY] = { baseUrl: 'https://ai.example/v1', model: 'test', apiKey: '' };
  };
  return { data, nodes, api, coordinator, enable, onAlarm };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('书签写入与自动分类', () => {
  it('移动可撤销，过期的预览不覆盖用户已修改的书签', async () => {
    const { coordinator, nodes, api } = setup();
    const plan = { classificationRevision: 0, archives: [], items: [{ bookmarkId: 'a', title: nodes.a.title,
      urlFingerprint: nodes.a.url!, originalParentId: 'bar', targetPath: '开发/数据库' }] };
    const applied = await coordinator.handle({ type: 'APPLY_BOOKMARK_ORGANIZE', plan });
    expect(applied.ok && applied.batch?.items[0].status, JSON.stringify(applied)).toBe('applied');
    const batchId = applied.ok ? applied.batch!.id : '';
    expect(nodes.a.parentId).not.toBe('bar');
    expect((await coordinator.handle({ type: 'UNDO_BOOKMARK_ORGANIZE', batchId })).ok).toBe(true);
    expect(nodes.a.parentId).toBe('bar');
    const before = api.move.mock.calls.length;
    nodes.a.title = '用户新标题';
    expect((await coordinator.handle({ type: 'APPLY_BOOKMARK_ORGANIZE', plan })).ok).toBe(false);
    expect(api.move.mock.calls.length).toBe(before);
  });
  it('应用后删除范围内空目录，保留仍有内容的目录，撤销时恢复', async () => {
    const { coordinator, nodes } = setup();
    nodes.empty = { syncing: false, id: 'empty', title: 'Apollo配置', parentId: 'bar', index: 1 };
    nodes.nonEmpty = { syncing: false, id: 'nonEmpty', title: '仍有内容', parentId: 'bar', index: 2 };
    nodes.nonEmptyChild = {
      syncing: false, id: 'nonEmptyChild', title: '保留书签', parentId: 'nonEmpty', index: 0,
      url: 'https://example.com/keep',
    };
    const plan = {
      classificationRevision: 0, cleanupEmptyFolders: true, archives: [],
      items: [{ bookmarkId: 'a', title: nodes.a.title, urlFingerprint: nodes.a.url!, originalParentId: 'bar',
        targetPath: '开发/数据库' }],
    };
    const applied = await coordinator.handle({ type: 'APPLY_BOOKMARK_ORGANIZE', plan });
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    expect(nodes.a.parentId).not.toBe('bar');
    expect(nodes.empty).toBeUndefined();
    expect(nodes.nonEmpty).toBeDefined();
    expect(applied.ok && applied.batch?.archivedFolders).toEqual([
      expect.objectContaining({ title: 'Apollo配置', mode: 'delete', status: 'applied' }),
    ]);

    const batchId = applied.ok ? applied.batch!.id : '';
    expect((await coordinator.handle({ type: 'UNDO_BOOKMARK_ORGANIZE', batchId })).ok).toBe(true);
    expect(nodes.a.parentId).toBe('bar');
    expect(Object.values(nodes).some((node) => node.title === 'Apollo配置' && !node.url)).toBe(true);
  });
  it('服务地址变更时不转发旧 Key，状态消息不返回凭据', async () => {
    const { coordinator } = setup();
    await saveAiConfig({ baseUrl: 'https://first.example/v1', model: 'model', apiKey: 'private-key' });
    await saveAiConfig({ baseUrl: 'https://first.example/v1', model: 'new-model' });
    expect((await loadAiConfig())?.apiKey).toBe('private-key');
    const status = await coordinator.handle({ type: 'GET_BOOKMARK_AI_STATUS' });
    expect(JSON.stringify(status)).not.toContain('private-key');
    await saveAiConfig({ baseUrl: 'https://second.example/v1', model: 'model' });
    expect((await loadAiConfig())?.apiKey).toBe('');
  });
  it('新收藏标题变化后继续分类，手动移走的收藏不分类', async () => {
    vi.useFakeTimers();
    const { coordinator, api, nodes, enable } = setup(); enable();
    const handle = vi.spyOn(coordinator, 'handleBookmarkCreated').mockResolvedValue();
    registerBookmarkAutoOrganize(coordinator);
    await vi.advanceTimersByTimeAsync(1);
    api.onCreated.fire('a', { ...nodes.a });
    await vi.advanceTimersByTimeAsync(300);
    nodes.a.title = '最终标题'; api.onChanged.fire('a', { title: '最终标题' });
    await vi.advanceTimersByTimeAsync(1800);
    expect(handle).toHaveBeenCalledOnce();
    handle.mockClear();
    api.onCreated.fire('a', { ...nodes.a });
    await vi.advanceTimersByTimeAsync(100);
    nodes.a.parentId = 'elsewhere'; api.onMoved.fire('a', {});
    await vi.advanceTimersByTimeAsync(2000);
    expect(handle).not.toHaveBeenCalled();
  });
  it('从持久化任务恢复；关闭开关时不接收新收藏', async () => {
    vi.useFakeTimers();
    const { coordinator, data, nodes, api } = setup();
    data['bookmarkOrganizer:pending:v2'] = [{ syncing: false, id: 'a', title: nodes.a.title, url: nodes.a.url, parentId: 'bar', due: 0 }];
    const handle = vi.spyOn(coordinator, 'handleBookmarkCreated').mockResolvedValue();
    registerBookmarkAutoOrganize(coordinator);
    await vi.advanceTimersByTimeAsync(10);
    expect(handle).toHaveBeenCalledOnce();
    handle.mockClear();
    api.onCreated.fire('a', { ...nodes.a });
    await vi.advanceTimersByTimeAsync(2000);
    expect(handle).not.toHaveBeenCalled();
  });
  it('导入事件不触发自动归类，旧版开关不会自动恢复开启', async () => {
    vi.useFakeTimers();
    const { coordinator, data, nodes, api, enable } = setup();
    data[ORGANIZER_STORAGE_KEY] = { ...defaultOrganizerState(), settings: { aiAutoPlaceEnabled: true, autoArchiveEnabled: true } };
    expect((await new ChromeOrganizerRepository().load()).settings.aiAutoPlaceEnabled).toBe(false);
    enable();
    const handle = vi.spyOn(coordinator, 'handleBookmarkCreated').mockResolvedValue();
    registerBookmarkAutoOrganize(coordinator);
    await vi.advanceTimersByTimeAsync(1);
    api.onImportBegan.fire(); api.onCreated.fire('a', { ...nodes.a }); api.onImportEnded.fire();
    await vi.advanceTimersByTimeAsync(2000);
    expect(handle).not.toHaveBeenCalled();
  });
});
