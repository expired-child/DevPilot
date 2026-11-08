import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeAiEndpoint, aiPermissionOrigin, validateAiConfig } from '../src/modules/bookmark-organizer/bookmark-ai-config';
import { aiBookmarkUrl, folderExamples, generateAiPreview, parseAiSuggestions, recommendBookmarkFolder } from '../src/modules/bookmark-organizer/bookmark-ai';
import { buildOrganizePreview } from '../src/modules/bookmark-organizer/bookmark-plan';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('兼容接口与分类响应', () => {
  it('保留自定义 API 路径，接受完整 endpoint，支持本地模型端口', () => {
    expect(normalizeAiEndpoint('https://ai.example/v1/')).toBe('https://ai.example/v1/chat/completions');
    expect(normalizeAiEndpoint('https://ai.example/proxy/chat/completions')).toBe('https://ai.example/proxy/chat/completions');
    expect(aiPermissionOrigin('http://localhost:11434/v1')).toBe('http://localhost/*');
    expect(() => normalizeAiEndpoint('https://user:pass@ai.example/v1')).toThrow();
    expect(() => normalizeAiEndpoint('https://ai.example/v1?key=secret')).toThrow();
    expect(() => normalizeAiEndpoint('http://remote.example/v1')).toThrow();
    expect(() => validateAiConfig({ baseUrl: 'https://ai.example/v1', model: '', apiKey: '' })).toThrow();
  });
  it('移除 URL 凭据、参数与片段；拒绝模型伪造、重复 ID 和无效目录', () => {
    expect(aiBookmarkUrl('https://u:p@example.com/article?token=secret#secret')).toBe('https://example.com/article');
    expect(aiBookmarkUrl('javascript:alert(1)')).toBeNull();
    const row = { bookmarkId: 'a', targetPath: '开发/MySQL', confidence: 0.9, reason: '数据库教程' };
    expect(parseAiSuggestions({ items: [row] }, ['a'])).toHaveLength(1);
    expect(() => parseAiSuggestions({ items: [row, row] }, ['a', 'b'])).toThrow();
    expect(() => parseAiSuggestions({ items: [{ ...row, bookmarkId: 'x' }] }, ['a'])).toThrow();
    expect(() => parseAiSuggestions({ items: [{ ...row, targetPath: '../test' }] }, ['a'])).toThrow();
  });
  it('使用用户指定地址、模型与 Key，低置信度不自动移动', async () => {
    vi.stubGlobal('chrome', { permissions: { contains: vi.fn().mockResolvedValue(true) } });
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ items: [{ bookmarkId: 'a', targetPath: '教程', confidence: 0.5, reason: '主题不确定' }] }),
    } }] })));
    vi.stubGlobal('fetch', fetcher);
    const result = await recommendBookmarkFolder({ baseUrl: 'https://ai.example/v1', model: 'custom-model', apiKey: 'test-key' },
      { bookmarkId: 'a', title: '文章', url: 'https://example.com/read?token=secret', fromRelativePath: '' }, ['教程']);
    expect(result.certain).toBe(false);
    expect(fetcher.mock.calls[0][0]).toBe('https://ai.example/v1/chat/completions');
    const request = fetcher.mock.calls[0][1];
    expect(JSON.parse(request.body).model).toBe('custom-model');
    expect(request.headers.Authorization).toBe('Bearer test-key');
    expect(request.body).not.toContain('token=secret');
    expect(request.body).not.toContain('thinking');
  });
  it('目录样例限量脱敏，调用失败不会产生分类结果', async () => {
    const examples = folderExamples(Array.from({ length: 10 }, (_, i) => ({ title: `教程${i}`, url: 'https://example.com/doc?key=secret', folder: '学习' })));
    expect(examples).toHaveLength(2);
    expect(examples[0].url).toBe('https://example.com/doc');
    vi.stubGlobal('chrome', { permissions: { contains: async () => true } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private error details', { status: 401 })));
    await expect(recommendBookmarkFolder({ baseUrl: 'https://ai.example/v1', model: 'custom', apiKey: '' },
      { bookmarkId: 'a', title: '教程', url: 'https://example.com', fromRelativePath: '' }, [], examples)).rejects.toThrow('API Key 无效');
  });
  it('DeepSeek 官方接口关闭思考模式，超时后用更小批次继续完整预览', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('chrome', { permissions: { contains: async () => true } });
    const bookmarkIds = Array.from({ length: 10 }, (_, index) => `bookmark-${index}`);
    const preview = buildOrganizePreview([{ id: '0', title: '', syncing: false, children: [{
      id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', syncing: false, children: bookmarkIds.map((id) => ({
        id, title: id, url: `https://example.com/${id}`, syncing: false,
      })),
    }] }], { rules: [], overrides: {} });
    const requested: string[][] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.thinking).toEqual({ type: 'disabled' });
      const ids: string[] = JSON.parse(body.messages[1].content).bookmarks.map((item: { bookmarkId: string }) => item.bookmarkId);
      requested.push(ids);
      if (requested.length === 1) return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
      const content = JSON.stringify({ items: ids.map((bookmarkId) => ({ bookmarkId, targetPath: '学习', confidence: 0.9, reason: '学习资料' })) });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    });
    vi.stubGlobal('fetch', fetcher);
    const pending = generateAiPreview(preview, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'test-key' }, new Set(), []);
    const checked = expect(pending).resolves.toMatchObject({ counts: { move: 10 } });
    await vi.advanceTimersByTimeAsync(25_000);
    await checked;
    expect(requested[0]).toEqual(bookmarkIds.slice(0, 8));
    expect(requested.slice(1).map((batch) => batch.length)).toEqual([4, 4, 2]);
    expect(requested.slice(1).flat()).toEqual(bookmarkIds);
  });
});
