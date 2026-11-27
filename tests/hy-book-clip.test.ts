import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { readBookPage, scanBook } from '../src/content/book-clip';
import { App } from '../src/sidepanel/App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('从表单或书签侧栏打开网页成书，扫描顶层网页并导出 Markdown 和 ZIP', async () => {
  const event = { addListener: () => {}, removeListener: () => {} };
  const url = 'https://example.test/course';
  const article = document.createElement('article');
  const paragraph = '这是一段用于验证网页成书的可见文章正文，导出的 Markdown 应当保留这些文字。';
  article.innerHTML = `<h1>示例文章</h1><p>${paragraph}</p><p hidden>不应导出的内容</p>`;
  const sendMessage = vi.fn(async (_tabId: number, message: { action: string }) => ({
    ok: true, book: message.action === 'scan' ? { scan: await scanBook(document, url) } : { page: readBookPage(document, url) },
  }));
  const downloads: Array<{ name: string | undefined; data: Uint8Array }> = [];
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({}) }, session: { get: async () => ({}) }, onChanged: event },
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: { query: async () => [{ id: 8 }], sendMessage },
    webNavigation: { getFrame: async () => ({ url }) },
    bookmarks: { getTree: async () => [], onCreated: event, onRemoved: event, onChanged: event, onMoved: event },
    downloads: { download: async (options: chrome.downloads.DownloadOptions) => {
      downloads.push({ name: options.filename, data: new Uint8Array(await (await fetch(options.url)).arrayBuffer()) });
      URL.revokeObjectURL(options.url);
      return downloads.length;
    } },
  });
  const container = document.createElement('div');
  // 真实侧栏与业务网页属于两个文档，不让侧栏自身参与正文识别。
  document.body.append(article);
  const root = createRoot(container);
  const click = async (label: string): Promise<void> => {
    const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
    expect(button, `可见的「${label}」按钮`).toBeDefined();
    await act(async () => { button?.click(); });
  };
  try {
    await act(async () => { root.render(createElement(App)); });
    await click('网页成书');
    await click('扫描当前网页');
    expect(sendMessage).toHaveBeenCalledWith(8, { type: 'BOOK_CLIP', action: 'scan' }, { frameId: 0 });
    expect(container.textContent).toContain('示例文章');
    await click('仅导出当前页 Markdown');
    await act(async () => { await vi.waitFor(() => expect(downloads).toHaveLength(1)); });
    expect(downloads[0].name).toBe('示例文章.md');
    const markdown = new TextDecoder().decode(downloads[0].data);
    expect(markdown).toContain(paragraph);
    expect(markdown).not.toContain('不应导出的内容');
    await click('导出所选章节');
    await act(async () => { await vi.waitFor(() => expect(downloads).toHaveLength(2)); });
    expect(downloads[1].name).toBe('示例文章.zip');
    expect([...downloads[1].data.slice(0, 4)]).toEqual([80, 75, 3, 4]);
    expect(new TextDecoder().decode(downloads[1].data)).toContain('book.md');
    await click('书签搜索');
    expect(container.querySelector('[role="combobox"]')).not.toBeNull();
    await click('网页成书');
    await click('表单剪贴板');
    expect(container.textContent).toContain('复制当前表单');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    article.remove();
    vi.unstubAllGlobals();
  }
});
