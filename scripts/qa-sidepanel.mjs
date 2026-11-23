import { mkdir, rm, mkdtemp, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// 真实扩展运行截图：隔离浏览器配置，仅写入测试书签和本地测试数据。
const output = path.resolve(process.env.DEVPILOT_QA_OUTPUT ?? '.vitest-attachments/sidepanel-ux');
const computed = {};
const temp = await mkdtemp(path.join(os.tmpdir(), 'devpilot-sidepanel-'));
const extension = path.join(temp, 'extension');
await mkdir(output, { recursive: true });
await cp(path.resolve('dist'), extension, { recursive: true });

const now = Date.now();
const item = (id, name, host, title, fieldCount, ageMinutes) => ({
  id,
  name,
  createdAt: now - ageMinutes * 60_000,
  updatedAt: now - ageMinutes * 60_000,
  source: { url: `https://${host}/form/${id}`, host, title },
  fields: Array.from({ length: fieldCount }, (_, index) => ({
    key: `${id}-field-${index}`,
    label: ['姓名', '手机号', '邮箱', '公司名称', '岗位'][index] ?? `字段 ${index}`,
    type: 'text',
    value: `示例值 ${index + 1}`,
  })),
  fingerprint: `fp-${id}`,
});

const clipboard = {
  currentId: 'resume',
  history: [
    item('resume', '简历投递 · 后端开发', 'jobs.example.com', '示例招聘网站 - 简历投递', 8, 2),
    item('candidate', '候选人登记', 'hr.example.com', 'HR 管理后台 - 候选人登记', 6, 35),
    item('checkout', '收货地址', 'shop.example.com', '购物结算 - 收货信息', 5, 190),
    item('long', '一个名称非常长的表单记录，用来验证窄侧栏下的截断与阅读体验', 'very-long-subdomain.example.com', '很长的来源网页标题，用来验证文本截断', 3, 1500),
  ],
  settings: {
    historyLimit: 50,
    replacementEnabled: true,
    replacementRules: [{ mode: 'regex', search: '\\.demo\\.example\\.com\\.cn', replacement: '.example.cn' }],
  },
  fieldRules: {},
  templates: [],
};

const organizer = {
  version: 1,
  classificationRevision: 1,
  rules: [{
    id: 'rule-host-example', kind: 'host', pattern: 'example.com', purpose: 'devops',
    project: 'MySQL', enabled: true, createdAt: 1,
  }],
  overrides: {},
  settings: { automationVersion: 2, autoArchiveEnabled: false, aiAutoPlaceEnabled: false },
  batches: [],
  activity: [],
};

let context;
try {
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 360, height: 900 },
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async ({ clipboard, organizer }) => {
    await globalThis.chrome.storage.local.set({ formClipboard: clipboard, 'bookmarkOrganizer:v1': organizer });
    const roots = (await globalThis.chrome.bookmarks.getTree())[0].children;
    const bar = roots.find((node) => node.folderType === 'bookmarks-bar') ?? roots[0];
    const learning = await globalThis.chrome.bookmarks.create({ parentId: bar.id, title: '学习' });
    const mysql = await globalThis.chrome.bookmarks.create({ parentId: learning.id, title: 'MySQL' });
    await globalThis.chrome.bookmarks.create({ parentId: mysql.id, title: 'MySQL 索引说明', url: 'https://example.com/index' });
    await globalThis.chrome.bookmarks.create({ parentId: bar.id, title: 'MySQL 事务与隔离级别', url: 'https://example.com/mysql' });
    for (let index = 1; index <= 11; index += 1) {
      await globalThis.chrome.bookmarks.create({ parentId: bar.id, title: `MySQL 学习笔记 ${index}`, url: `https://example.com/mysql/${index}` });
    }
  }, { clipboard, organizer });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('heading', { name: 'DevPilot' }).waitFor();

  const capture = async (name, widths = [360], fullPage = true) => {
    for (const width of widths) {
      for (const theme of ['light', 'dark']) {
        if (width !== 360 && theme === 'dark') continue;
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        const overflow = await page.evaluate(() => {
          if (globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth) return [];
          return [...globalThis.document.querySelectorAll('*')]
            .map((element) => ({ element, rect: element.getBoundingClientRect() }))
            .filter(({ rect }) => rect.right > globalThis.innerWidth + 0.5)
            .slice(0, 8)
            .map(({ element, rect }) => `${element.tagName.toLowerCase()}.${String(element.className)} right=${Math.round(rect.right)} width=${Math.round(rect.width)}`);
        });
        await page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage });
        if (name === '04-organize' && theme === 'dark') {
          computed.darkOrganize = await page.evaluate(() => {
            const pick = (selector) => {
              const element = globalThis.document.querySelector(selector);
              if (!element) return null;
              const style = globalThis.getComputedStyle(element);
              return { color: style.color, background: style.backgroundColor, borderTopColor: style.borderTopColor };
            };
            return {
              hero: pick('.organize-hero'), more: pick('.organize-more > summary'),
              ai: pick('.organize-ai-settings > summary'), status: pick('.organize-status'),
              chevron: pick('.organize-row-chevron'),
            };
          });
        }
        if (name === '05-organize-editor') {
          const layout = await page.evaluate(() => {
            const measure = (element) => {
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) };
            };
            const sheet = globalThis.document.querySelector('.organize-editor');
            return {
              viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
              sheet: measure(sheet),
              scrollHeight: sheet?.scrollHeight ?? 0, clientHeight: sheet?.clientHeight ?? 0,
              bodyLocked: globalThis.document.body.classList.contains('organize-modal-open'),
            };
          });
          computed.editorLayout = { ...(computed.editorLayout ?? {}), [`${width}-${theme}`]: layout };
        }
        if (overflow.length > 0) errors.push(`horizontal overflow: ${name} ${width} ${theme} :: ${overflow.join(' | ')}`);
      }
    }
    await page.setViewportSize({ width: 360, height: 900 });
    await page.emulateMedia({ colorScheme: 'light' });
  };

  await capture('01-home', [320, 360, 720]);

  await page.getByRole('button', { name: '书签搜索' }).first().click();
  await page.waitForTimeout(150);
  await capture('02-bookmarks-empty');

  await page.getByLabel('搜索浏览器书签').fill('MySQL');
  await page.waitForTimeout(150);
  await capture('03-bookmarks-results');

  await page.getByRole('button', { name: '智能整理与自动分类' }).click();
  await page.getByText('整理范围', { exact: false }).first().waitFor();
  await page.getByRole('region', { name: '整理预览' }).waitFor();
  await capture('04-organize', [320, 360, 720]);

  await page.getByRole('button', { name: /修改「MySQL 索引说明」的分类/ }).click();
  await page.getByRole('dialog', { name: /修改「MySQL 索引说明」的分类/ }).waitFor();
  await page.waitForTimeout(250);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  computed.reducedMotion = await page.evaluate(() => {
    const animationName = (selector) => {
      const element = globalThis.document.querySelector(selector);
      return element ? globalThis.getComputedStyle(element).animationName : 'missing';
    };
    return { sheet: animationName('.organize-editor'), backdrop: animationName('.organize-editor-backdrop') };
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (computed.reducedMotion.sheet !== 'none' || computed.reducedMotion.backdrop !== 'none') {
    errors.push(`reduced motion still animates: ${JSON.stringify(computed.reducedMotion)}`);
  }
  await capture('05-organize-editor', [320, 360, 720], false);
  await page.getByRole('button', { name: '取消修改分类' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.waitForFunction(() => globalThis.document.activeElement?.getAttribute('aria-label')?.startsWith('修改「'));
  computed.editorClosed = await page.evaluate(() => ({
    bodyLocked: globalThis.document.body.classList.contains('organize-modal-open'),
    focused: globalThis.document.activeElement?.getAttribute('aria-label') ?? '',
  }));

  await page.getByLabel('搜索浏览器书签').count().catch(() => {});
  const report = { output, errors, computed, bodyText: (await page.locator('body').innerText()).slice(0, 600) };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await context?.close();
  if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('devpilot-sidepanel-')) {
    await rm(temp, { recursive: true, force: true });
  }
}