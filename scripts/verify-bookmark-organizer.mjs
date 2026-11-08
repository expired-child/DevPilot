import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const rgbChannels = (value) => (value.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 3).map(Number);
const linearChannel = (value) => {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};
const relativeLuminance = (value) => {
  const [red, green, blue] = rgbChannels(value);
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
};
const contrastRatio = (foreground, background) => {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};
const assertConfirmContrast = (style, label) => {
  const ratio = contrastRatio(style.color, style.background);
  assert(Number.isFinite(ratio) && ratio >= 4.5, `${label} 对比度不足：${ratio.toFixed(2)} ${JSON.stringify(style)}`);
};

// 使用隔离的浏览器、测试书签和本地模拟 AI，不访问用户收藏或外部模型。
const requests = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const data = JSON.parse(body); requests.push(data);
  const input = JSON.parse(data.messages[1].content);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: input.bookmarks.map((item) => {
    const targetPath = item.title === '无目标书签' ? null
      : item.title === 'MySQL 索引说明' ? '学习/MySQL/索引'
        : item.title.includes('前端') ? '学习/前端' : '学习/MySQL';
    const confidence = item.title === '无目标书签' ? 0.9 : item.title === 'MySQL 索引说明' ? 0.6 : 0.96;
    return { bookmarkId: item.bookmarkId, targetPath, confidence, reason: '测试服务根据文章主题推荐目录' };
  }) }) } }] }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const temp = await mkdtemp(path.join(os.tmpdir(), 'devpilot-bookmark-'));
const extension = path.join(temp, 'extension');
const output = path.resolve(process.env.DEVPILOT_QA_OUTPUT ?? '.vitest-attachments/bookmark-organizer');
let context;
try {
  await cp(path.resolve('dist'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  // 仅在测试副本预授予本地服务权限，免除无人值守环境的浏览器权限弹窗。
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  await mkdir(output, { recursive: true });
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 360, height: 900 } });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const seed = await worker.evaluate(async () => {
    const roots = (await globalThis.chrome.bookmarks.getTree())[0].children;
    const bar = roots.find((node) => node.folderType === 'bookmarks-bar') ?? roots.find((node) => node.id === '1');
    const learning = await globalThis.chrome.bookmarks.create({ parentId: bar.id, title: '学习' });
    const mysql = await globalThis.chrome.bookmarks.create({ parentId: learning.id, title: 'MySQL' });
    await globalThis.chrome.bookmarks.create({ parentId: mysql.id, title: 'MySQL 索引说明', url: 'https://example.com/index' });
    await globalThis.chrome.bookmarks.create({ parentId: bar.id, title: 'Apollo配置' });
    await globalThis.chrome.bookmarks.create({ parentId: bar.id, title: '无目标书签', url: 'https://example.com/unknown' });
    const article = await globalThis.chrome.bookmarks.create({ parentId: bar.id, title: 'MySQL 事务与隔离级别', url: 'https://example.com/mysql?token=private' });
    for (let index = 1; index <= 11; index += 1) {
      await globalThis.chrome.bookmarks.create({ parentId: bar.id, title: `MySQL 学习笔记 ${index}`, url: `https://example.com/mysql/${index}` });
    }
    return { bar: bar.id, article: article.id, mysql: mysql.id };
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: '书签搜索', exact: false }).click();
  await page.getByRole('button', { name: '智能整理与自动分类' }).click();
  await page.locator('.organize-ai-settings > summary').click();
  await page.getByLabel('AI 服务地址').fill(`http://127.0.0.1:${port}/v1`);
  await page.getByLabel('AI 模型名称').fill('local-test-model');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('AI 配置已保存在本机', { exact: false }).waitFor().catch(async (error) => {
    process.stdout.write(await page.locator('body').innerText()); throw error;
  });
  await page.getByRole('button', { name: '生成 AI 整理预览' }).click();
  await page.getByText('AI 预览已生成', { exact: false }).waitFor();
  assert(requests.some((req) => JSON.parse(req.messages[1].content).folderExamples.length > 0));
  assert(!JSON.stringify(requests).includes('token=private'));
  const preview = page.getByRole('region', { name: '整理预览' });
  const pager = preview.getByRole('navigation', { name: '预览分页', exact: true });
  const hasFolder = async (title) => worker.evaluate(async (targetTitle) => {
    const stack = await globalThis.chrome.bookmarks.getTree();
    while (stack.length > 0) {
      const node = stack.pop();
      if (node.title === targetTitle && !node.url) return true;
      if (node.children) stack.push(...node.children);
    }
    return false;
  }, title);
  const archiveToggle = preview.getByRole('checkbox', { name: /删除范围内.*空文件夹/ });
  await archiveToggle.waitFor();
  assert(await archiveToggle.isChecked());
  assert(await hasFolder('Apollo配置'));
  // 有不同目标的行显示「有建议·待采用」；采用只增加选择状态，不改变分类徽标。
  const aiConfirmRow = preview.locator('[data-bookmark-id]').filter({ hasText: 'MySQL 索引说明' }).first();
  const aiConfirm = aiConfirmRow.locator('.organize-row-confirm');
  await aiConfirm.waitFor();
  const applyButton = preview.getByRole('button', { name: /应用选中的/ });
  const styleOf = (element) => {
    const style = globalThis.getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  };
  assert.equal((await aiConfirmRow.locator('.badge').textContent())?.trim(), '有建议·待采用');
  await page.emulateMedia({ colorScheme: 'dark' });
  await aiConfirm.hover();
  await page.waitForTimeout(250);
  assertConfirmContrast(await aiConfirm.evaluate(styleOf), '暗色采用目标按钮悬停');
  await page.emulateMedia({ colorScheme: 'light' });
  await aiConfirm.click();
  const selectionTag = aiConfirmRow.locator('.organize-row-selection');
  await selectionTag.waitFor();
  assert.equal(await aiConfirm.count(), 0);
  assert.equal((await aiConfirmRow.locator('.badge').textContent())?.trim(), '有建议·待采用');
  assert.equal((await selectionTag.textContent())?.trim(), '已选入批次');
  assert.equal((await aiConfirmRow.locator('.visually-hidden').textContent())?.trim(), '有建议·待采用；已选入批次');
  const selectionElement = await selectionTag.evaluate((element) => ({
    tag: element.tagName,
    role: element.getAttribute('role'),
    tabIndex: element.getAttribute('tabindex'),
  }));
  assert.equal(selectionElement.tag, 'SPAN');
  assert.equal(selectionElement.role, null);
  assert.equal(selectionElement.tabIndex, null);
  assert(await aiConfirmRow.getByRole('checkbox').isChecked());
  assert.equal((await applyButton.textContent())?.trim(), '应用选中的 13 项');
  const focusedAfterConfirm = await page.evaluate(() => ({
    tag: globalThis.document.activeElement?.tagName ?? '',
    label: globalThis.document.activeElement?.getAttribute('aria-label') ?? '',
  }));
  assert.equal(focusedAfterConfirm.tag, 'INPUT');
  assert.equal(focusedAfterConfirm.label, '选择「MySQL 索引说明」');
  assert(await aiConfirmRow.getByRole('button', { name: /修改「MySQL 索引说明」的分类/ }).isVisible());
  assertConfirmContrast(await selectionTag.evaluate(styleOf), '已选入批次标记');
  await page.screenshot({ path: path.join(output, 'review-confirm-360-light.png') });
  await page.setViewportSize({ width: 320, height: 900 });
  assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), '选择状态在 320px 溢出');
  await page.screenshot({ path: path.join(output, 'review-confirm-320-light.png') });
  await page.setViewportSize({ width: 360, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(250);
  assertConfirmContrast(await selectionTag.evaluate(styleOf), '暗色已选入批次标记');
  await page.screenshot({ path: path.join(output, 'review-confirm-360-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await aiConfirmRow.getByRole('checkbox').uncheck();
  await aiConfirm.waitFor();
  assert.equal(await selectionTag.count(), 0);
  assert.equal((await aiConfirmRow.locator('.visually-hidden').textContent())?.trim(), '有建议·待采用；未选入批次');
  assert.equal((await aiConfirm.textContent())?.trim(), '采用目标');
  assert.equal(await aiConfirmRow.getByRole('checkbox').isChecked(), false);
  assert.equal((await applyButton.textContent())?.trim(), '应用选中的 12 项');
  // 无目标行与同目录目标行都不可选入批次，且给出下一步。
  const noTargetRow = preview.locator('[data-bookmark-id]').filter({ hasText: '无目标书签' }).first();
  assert.equal((await noTargetRow.locator('.badge').textContent())?.trim(), '无建议·保持原位');
  assert.equal(await noTargetRow.getByRole('checkbox').count(), 0);
  assert.match(await noTargetRow.textContent(), /填写一个与当前位置不同的目标文件夹/);
  await aiConfirmRow.locator('.organize-row-title').click();
  const targetInput = aiConfirmRow.getByLabel('修改「MySQL 索引说明」的目标文件夹');
  await targetInput.fill('');
  await aiConfirm.waitFor({ state: 'detached' });
  assert.equal((await aiConfirmRow.locator('.badge').textContent())?.trim(), '无建议·保持原位');
  assert.equal(await aiConfirmRow.getByRole('checkbox').count(), 0);
  assert.equal((await applyButton.textContent())?.trim(), '应用选中的 12 项');
  await targetInput.fill('学习/MySQL');
  assert.equal((await aiConfirmRow.locator('.badge').textContent())?.trim(), '目标在原位');
  assert.equal(await aiConfirmRow.getByRole('checkbox').count(), 0);
  assert.match(await aiConfirmRow.textContent(), /保持原位（目标与当前位置相同）/);
  await targetInput.fill('学习/MySQL/索引');
  await aiConfirm.waitFor();
  await aiConfirmRow.locator('.organize-row-title').click();
  await pager.getByText('第 1 / 2 页', { exact: true }).waitFor();
  assert.equal(await preview.locator('[data-bookmark-id]').count(), 10);
  await pager.getByRole('button', { name: '下一页' }).click();
  await pager.getByText('第 11–14 条，共 14 条', { exact: true }).waitFor();
  assert.equal(await preview.locator('[data-bookmark-id]').count(), 4);
  assert(await pager.getByRole('button', { name: '下一页' }).isDisabled());
  const deselected = preview.getByRole('checkbox', { name: /选择「MySQL 学习笔记/ }).last();
  const deselectedLabel = await deselected.getAttribute('aria-label');
  await deselected.uncheck();
  await preview.getByRole('button', { name: '确定项 12', exact: true }).click();
  await pager.getByText('第 1 / 2 页', { exact: true }).waitFor();
  await pager.getByRole('button', { name: '下一页' }).click();
  assert.equal(await preview.locator('[data-bookmark-id]').count(), 2);
  assert.equal(await preview.getByRole('checkbox', { name: deselectedLabel, exact: true }).isChecked(), false);
  await preview.getByRole('button', { name: '应用选中的 11 项', exact: true }).waitFor();
  await preview.getByRole('navigation', { name: '列表底部分页' }).getByRole('button', { name: '上一页' }).click();
  await pager.getByText('第 1 / 2 页', { exact: true }).waitFor();
  for (const [width, theme] of [[360, 'light'], [320, 'dark'], [720, 'light']]) {
    await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme: theme });
    assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), `overflow ${width}`);
    await page.screenshot({ path: path.join(output, `preview-${width}-${theme}.png`), fullPage: true });
    await pager.screenshot({ path: path.join(output, `pagination-${width}-${theme}.png`) });
  }
  await page.getByRole('button', { name: /应用选中的/ }).click();
  await page.getByRole('heading', { name: '批次结果' }).waitFor();
  assert.equal(await worker.evaluate(async (id) => (await globalThis.chrome.bookmarks.get(id))[0].parentId, seed.article), seed.mysql);
  assert.equal(await hasFolder('Apollo配置'), false);
  await page.getByRole('button', { name: /撤销/ }).first().click();
  await page.getByText('已撤销', { exact: true }).first().waitFor();
  assert.equal(await worker.evaluate(async (id) => (await globalThis.chrome.bookmarks.get(id))[0].parentId, seed.article), seed.bar);
  assert.equal(await hasFolder('Apollo配置'), true);
  await page.getByRole('button', { name: '重新扫描', exact: true }).click();
  const autoPlace = page.getByLabel('新书签 AI 智能放置');
  await autoPlace.click();
  await autoPlace.and(page.locator(':checked')).waitFor();
  const fresh = await worker.evaluate(async (parentId) => {
    const node = await globalThis.chrome.bookmarks.create({ parentId, title: '加载中', url: 'https://example.com/frontend' });
    await globalThis.chrome.bookmarks.update(node.id, { title: '前端布局学习指南' }); return node.id;
  }, seed.bar);
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const parent = await worker.evaluate(async (id) => (await globalThis.chrome.bookmarks.get(id))[0].parentId, fresh);
    if (parent !== seed.bar) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const finalFolder = await worker.evaluate(async (id) => {
    const [node] = await globalThis.chrome.bookmarks.get(id); return (await globalThis.chrome.bookmarks.get(node.parentId))[0].title;
  }, fresh);
  assert.equal(finalFolder, '前端');

  // 保存单条修正后保留其他行的勾选与当前页；返回前有未应用改动需确认。
  await page.getByRole('button', { name: '重新扫描', exact: true }).click();
  const refreshed = page.getByRole('region', { name: '整理预览' });
  await refreshed.waitFor();
  const refreshedPager = refreshed.getByRole('navigation', { name: '预览分页', exact: true });
  // 规则预览下这些示例书签都是待确认，切到全部筛选后仍有跨页条目。
  await refreshed.getByRole('button', { name: /^全部/ }).click();
  await refreshedPager.getByText('第 1 / 2 页', { exact: true }).waitFor();
  await refreshedPager.getByRole('button', { name: '下一页' }).click();
  await refreshedPager.getByText('第 2 / 2 页', { exact: true }).waitFor();
  const noteRow = refreshed.locator('[data-bookmark-id]').filter({ hasText: 'MySQL 学习笔记 11' }).first();
  // 规则预览没有可执行目标，先填一个不同目录让该行进入批次。
  await noteRow.locator('.organize-row-title').click();
  await noteRow.getByLabel('修改「MySQL 学习笔记 11」的目标文件夹').fill('学习/笔记');
  const noteCheckbox = noteRow.getByRole('checkbox');
  const noteLabel = await noteCheckbox.getAttribute('aria-label');
  await noteCheckbox.check();
  // 修正另一条，验证勾选与页码不被这次重建覆盖。
  const otherRow = refreshed.locator('[data-bookmark-id]').filter({ hasText: 'MySQL 学习笔记 10' }).first();
  await otherRow.getByRole('button', { name: /修改「/ }).click();
  await page.getByRole('button', { name: '仅修正此条' }).click();
  await page.locator('.organize-editor').waitFor({ state: 'detached' });
  await refreshedPager.getByText('第 2 / 2 页', { exact: true }).waitFor();
  assert.equal(await refreshed.getByRole('checkbox', { name: noteLabel, exact: true }).isChecked(), true);
  await page.waitForFunction(() => globalThis.document.activeElement?.getAttribute('aria-label')?.startsWith('修改「'));
  const restoredFocus = await page.evaluate(() => ({
    tag: globalThis.document.activeElement?.tagName ?? '',
    label: globalThis.document.activeElement?.getAttribute('aria-label') ?? '',
  }));
  assert.notEqual(restoredFocus.tag, 'BODY');
  assert.match(restoredFocus.label, /^修改「/);

  let leaveMessage = '';
  page.once('dialog', async (dialog) => { leaveMessage = dialog.message(); await dialog.dismiss(); });
  await page.getByRole('button', { name: '返回书签搜索' }).click();
  await page.waitForTimeout(80);
  assert.match(leaveMessage, /丢失当前勾选/);
  assert(await page.getByRole('heading', { name: '智能整理', exact: true }).isVisible());

  assert.deepEqual(errors, []);
  process.stdout.write(`真实扩展流程通过：配置、目标采用与取消勾选、无目标/同目录状态、暗色悬停、预览分页、跨页勾选、移动、撤销、新收藏自动分类、单条修正保留勾选与页码及焦点、返回确认；截图 ${output}\n`);
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  // temp 为本脚本 mkdtemp 生成且经过根目录校验的隔离目录。
  if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('devpilot-bookmark-')) await rm(temp, { recursive: true, force: true });
}
