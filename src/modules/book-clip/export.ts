import { getActiveTab, sendToTab } from '../../shared/messaging/tab-messaging';
import { lowerHeadings, markdownText } from './markdown';
import { chapterKey, webUrl, type BookChapter, type BookClipAction, type BookClipResult, type BookPage, type BookScan } from './types';
import { buildBookZip, type BookFile } from './zip';

export interface BookTarget { tabId: number; scan: BookScan }
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const explanation = (error: unknown) => error instanceof Error ? error.message : '未知错误';
const removedFragment = (url: string) => url.split('#', 1)[0];
const sameResource = (a: string, b: string) => removedFragment(a) === removedFragment(b);
const nameOf = (value: string) => {
  const clean = [...value.trim()].map(c => c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? '_' : c)
    .slice(0, 90).join('').replace(/[. ]+$/u, '') || '未命名';
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(clean) ? `_${clean}` : clean;
};

async function call(tabId: number, action: BookClipAction): Promise<BookClipResult> {
  const response = await sendToTab(tabId, { type: 'BOOK_CLIP', ...action });
  if (response?.ok && 'book' in response) return response.book;
  throw new Error(response && !response.ok ? response.error : '未获取到网页采集结果');
}

export async function scanActiveBook(): Promise<BookTarget> {
  const tab = await getActiveTab();
  try {
    const result = await call(tab.id!, { action: 'scan' });
    if ('scan' in result) return { tabId: tab.id!, scan: result.scan };
    throw new Error('未获取到网页目录');
  } catch (error) {
    if (/Receiving end does not exist|Could not establish connection/iu.test(explanation(error))) {
      throw new Error('无法访问当前页，请打开普通网页并刷新后再扫描。', { cause: error });
    }
    throw error;
  }
}

async function getPage(tabId: number, origin: string): Promise<BookPage> {
  const result = await call(tabId, { action: 'extract', origin });
  if (!('page' in result)) throw new Error('未获取到正文');
  return result.page;
}

async function download(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

interface ImageSet {
  saved: Map<string, BookFile>;
  missing: Map<string, string>;
  bytes: number;
}

async function saveImages(tabId: number, origin: string, page: BookPage, images: ImageSet, signal: AbortSignal): Promise<void> {
  const urls = [...new Set(page.images.map(({ url }) => url))].filter(url => !images.saved.has(url) && !images.missing.has(url));
  const available = Math.max(0, 600 - images.saved.size - images.missing.size);
  const limit = 128 * 1024 * 1024;
  for (let i = 0; i < Math.min(available, urls.length) && !signal.aborted && images.bytes < limit; i += 4) {
    const batch = urls.slice(i, Math.min(i + 4, available));
    const results = await Promise.allSettled(batch.map(url => call(tabId, { action: 'image', origin, url, pageUrl: page.url })));
    results.forEach((result, index) => {
      const url = batch[index];
      if (result.status === 'rejected') { images.missing.set(url, explanation(result.reason)); return; }
      if (!('image' in result.value)) { images.missing.set(url, '没有返回图片'); return; }
      const { base64, extension } = result.value.image;
      if (!/^[a-z0-9]{2,4}$/u.test(extension) || base64.length > Math.ceil(8 * 1024 * 1024 / 3) * 4) {
        images.missing.set(url, '图片超限或格式不受支持');
        return;
      }
      let content: Uint8Array<ArrayBuffer>;
      try { content = Uint8Array.from(atob(base64), char => char.charCodeAt(0)); }
      catch { images.missing.set(url, '图片编码无效'); return; }
      if (images.bytes + content.length > limit) { images.missing.set(url, '超过 ZIP 图片总大小限制'); return; }
      images.bytes += content.length;
      images.saved.set(url, { name: `assets/image-${String(images.saved.size + 1).padStart(4, '0')}.${extension}`, content });
    });
  }
}

function chapterMarkdown(page: BookPage, images?: ImageSet, prefix = ''): string {
  const parts: string[] = [];
  let cursor = 0;
  if (images) for (const { url, offset, length } of page.images) {
    const asset = images.saved.get(url);
    if (!asset) continue;
    parts.push(page.markdown.slice(cursor, offset), prefix + asset.name);
    cursor = offset + length;
  }
  parts.push(page.markdown.slice(cursor));
  return `${parts.join('').trim()}\n\n> 来源：${page.url}\n`;
}

interface ExportOptions {
  target: BookTarget;
  chapters?: BookChapter[];
  title: string;
  format: 'md' | 'zip';
  restore: boolean;
  signal: AbortSignal;
  onProgress(text: string): void;
}

export async function exportBook({ target, chapters, title, format, restore, signal, onProgress }: ExportOptions): Promise<string> {
  if ((await getActiveTab()).id !== target.tabId) throw new Error('当前标签页已切换，请重新扫描。');
  const { tabId, scan } = target;
  const origin = new URL(scan.url).origin;
  const currentUrl = async () => (await chrome.webNavigation.getFrame({ tabId, frameId: 0 }))?.url ?? '';
  const assertOrigin = (url: string) => {
    if (webUrl(url)?.origin !== origin) throw new Error('当前标签页已离开原站点，请重新扫描。');
  };
  const initial = await getPage(tabId, origin);
  if (!chapters) {
    if (initial.textLength < 25) throw new Error('当前文章内容太短，无法确定正文。');
    if (signal.aborted) return '已停止。';
    await download(new Blob([chapterMarkdown(initial)], { type: 'text/markdown;charset=utf-8' }), `${nameOf(initial.title)}.md`);
    return '已提交 1 篇给浏览器下载。';
  }
  if (!chapters.length) throw new Error('请先选择要导出的章节。');
  if (!sameResource(initial.url, scan.url)) throw new Error('页面已切换，请重新扫描目录。');
  const passed: BookPage[] = [];
  const skipped: string[] = [];
  const images = format === 'zip' ? { saved: new Map(), missing: new Map(), bytes: 0 } satisfies ImageSet : undefined;
  const total = Math.min(chapters.length, 450);
  let previous = initial;
  let navigated = false;
  let textSize = 0;
  try {
    for (const [index, chapter] of chapters.slice(0, total).entries()) {
      if (signal.aborted) break;
      const start = await currentUrl();
      if (webUrl(start)?.origin !== origin) {
        skipped.push('标签页已离开原站点，未继续读取其余章节。');
        break;
      }
      onProgress(`正在读取 ${index + 1}/${total}：${chapter.title}`);
      try {
        const matches = (page: BookPage) => page.textLength >= 25 && (chapter.url
          ? sameResource(page.url, chapter.url) : chapterKey(page.title) === chapterKey(chapter.title));
        let page: BookPage;
        if (matches(previous) && sameResource(await currentUrl(), previous.url)) {
          page = previous;
        } else {
          if (chapter.url) assertOrigin(chapter.url);
          const before = await currentUrl();
          navigated = true;
          const result = await call(tabId, { action: 'jump', origin, chapter }).catch(() => null);
          const after = await currentUrl();
          if (after) assertOrigin(after);
          if (!(result && 'jumped' in result && result.jumped) && before === after) {
            if (!chapter.url || chapter.url === after) throw new Error('未找到可用的章节入口');
            await chrome.tabs.update(tabId, { url: chapter.url });
          }
          const deadline = Date.now() + 16_500;
          let candidate: BookPage | undefined;
          for (;;) {
            await wait(450);
            if (signal.aborted || Date.now() > deadline) throw new Error('页面未能确认切换到此章节');
            const href = await currentUrl();
            if (!href) continue;
            assertOrigin(href);
            const read = await getPage(tabId, origin).catch(() => undefined);
            if (!read || !matches(read) || (read.markdown === previous.markdown && sameResource(read.url, previous.url))) {
              candidate = undefined;
              continue;
            }
            const plausible = chapterKey(read.title) === chapterKey(chapter.title) || read.markdown !== previous.markdown;
            if (plausible && candidate?.url === read.url && candidate.markdown === read.markdown) { page = read; break; }
            candidate = plausible ? read : undefined;
          }
        }
        if (passed.some(item => item.url === page.url && item.markdown === page.markdown)) throw new Error('与已保存章节重复');
        if (textSize + page.markdown.length > 10_000_000) throw new Error('超过本次导出的正文大小限制');
        textSize += page.markdown.length;
        passed.push(page);
        previous = page;
        if (images) {
          onProgress(`正在保存 ${index + 1}/${total} 的图片`);
          await saveImages(tabId, origin, page, images, signal);
        }
      } catch (error) {
        if (!signal.aborted) skipped.push(`${markdownText(chapter.title)}：${markdownText(explanation(error))}`);
      }
    }

    if (!passed.length) {
      if (signal.aborted) return '已停止，未采集到可保存的章节。';
      throw new Error(`没有成功提取的章节。${skipped[0] ?? '请确认当前页面可以正常阅读。'}`);
    }
    const book = title.trim() || scan.title;
    const safeTitle = markdownText(book.replace(/\s+/gu, ' '));
    const index = passed.map((page, i) => `${i + 1}. [${markdownText(page.title)}](#chapter-${i + 1})`).join('\n');
    const sections = passed.map((page, i) => `<a id="chapter-${i + 1}"></a>\n\n${lowerHeadings(chapterMarkdown(page, images))}`);
    const failures = skipped.length ? `\n## 跳过的章节\n\n${skipped.map(entry => `- ${entry}`).join('\n')}\n` : '';
    const markdown = `# ${safeTitle}\n\n> 来源：${scan.url}\n\n## 目录\n\n${index}\n\n${sections.join('\n---\n\n')}${failures}`;
    onProgress('正在生成文件…');
    if (images) {
      const files: BookFile[] = [
        { name: 'book.md', content: markdown },
        { name: 'README.md', content: '# 阅读方式\n\n打开 [book.md](book.md) 阅读全书，或在 `chapters/` 逐章阅读。保留 `assets/` 以便离线查看图片。\n' },
        { name: 'export-info.json', content: JSON.stringify({ title: book, source: scan.url, chapters: passed.map(({ title, url }) => ({ title, url })), skipped }, null, 2) },
        ...passed.map((page, i) => ({ name: `chapters/${String(i + 1).padStart(3, '0')} - ${nameOf(page.title)}.md`, content: chapterMarkdown(page, images, '../') })),
        ...images.saved.values(),
      ];
      const missing = [...new Set(passed.flatMap(page => page.images.map(({ url }) => url)))].filter(url => !images.saved.has(url));
      if (missing.length) files.push({ name: 'MISSING-IMAGES.md', content: '# 未能离线保存的图片\n\n原链接已保留在正文。\n\n' + missing.map(href => {
        const url = new URL(href);
        return `- ${markdownText(url.host + url.pathname)}：${markdownText(images.missing.get(href) ?? (signal.aborted ? '导出已停止' : '达到图片数量或体积限制'))}`;
      }).join('\n') + '\n' });
      if (failures) files.push({ name: 'SKIPPED.md', content: failures.trimStart() });
      await download(buildBookZip(files), `${nameOf(book)}.zip`);
    } else {
      await download(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${nameOf(book)}.md`);
    }
    return `${signal.aborted ? '已停止，' : ''}已提交 ${passed.length} 篇给浏览器下载，跳过 ${skipped.length} 篇。`;
  } finally {
    if (restore && navigated) {
      const url = await currentUrl().catch(() => '');
      if (url && url !== initial.url && webUrl(url)?.origin === origin) {
        await chrome.tabs.update(tabId, { url: initial.url }).catch(() => {});
      }
    }
  }
}
