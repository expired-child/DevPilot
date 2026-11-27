import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';
import { chromium } from 'playwright';

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const [loader] = manifest.content_scripts[0].js;
const browser = await chromium.launch();
const context = await browser.newContext();

try {
  const site = 'https://preview.test';
  // 使用构建后的内容脚本和真实 Chromium 下载事件，仅替换扩展消息环境。
  await context.addInitScript(() => {
    globalThis.chrome ??= {};
    globalThis.chrome.runtime = {
      getURL: (asset) => `/extension/${asset}`,
      onMessage: { addListener: () => {} },
      sendMessage: async (message) => {
        if (message.type === 'GET_SHORTCUT_BINDINGS') globalThis.devpilotReady = true;
        else globalThis.downloadRequest = message;
        return { ok: true };
      },
    };
  });
  await context.route(`${site}/extension/**`, (route) => route.fulfill({
    path: `dist/${new URL(route.request().url()).pathname.slice('/extension/'.length)}`,
    contentType: 'text/javascript',
  }));
  const source = "-- 示例\nCREATE TABLE `demo` (`id` BIGINT NOT NULL AUTO_INCREMENT, `start` DATETIME, `name` VARCHAR(20) DEFAULT '<script>throw new Error(1)</script>');";
  const javaSource = 'public class Demo { private String name = "示例"; }';
  const plainSource = 'CREATE TABLE\n这是一段普通文本';
  const longSource = `SELECT 1;\n${' '.repeat(100_000)}DROP TABLE demo;`;
  await context.route(`${site}/`, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `
      <a href="/files/migration.SQL">查看 SQL</a>
      <a href="/files/Demo.java">查看 Java</a>
      <a href="/files/notes.txt">查看文本</a>
      <a href="/files/long.sql">查看大文件</a>
      <a href="/files/photo.png?signature=token" download><span>查看图片</span></a>
      <a href="/api/file?id=42&amp;fileName=clip.webm" download>查看视频</a>
      <a href="/api/file?id=43" download="missing.webm">失效附件</a>
      <a href="/files/setup.exe" download="setup.sql">安装包</a>
      <a href="/files/system.iso" download>镜像</a>
      <a href="https://files.test/remote.png">跨站图片</a>
    `,
  }));
  await context.route(`${site}/files/migration.SQL`, (route) => route.fulfill({
    contentType: 'application/octet-stream',
    headers: { 'content-disposition': 'attachment; filename="migration.SQL"' },
    body: source,
  }));

  await context.route(`${site}/files/Demo.java`, (route) => route.fulfill({ contentType: 'text/plain', body: javaSource }));
  await context.route(`${site}/files/notes.txt`, (route) => route.fulfill({ contentType: 'text/plain', body: plainSource }));
  await context.route(`${site}/files/long.sql`, (route) => route.fulfill({ contentType: 'text/plain', body: longSource }));

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
  await context.route(`${site}/files/photo.png?**`, (route) => route.fulfill({
    contentType: 'image/png',
    headers: { 'content-disposition': 'attachment; filename="photo.png"' },
    body: png,
  }));
  await context.route('https://files.test/remote.png', (route) => route.fulfill({
    contentType: 'image/png',
    body: png,
  }));
  await context.route(`${site}/api/file?id=43`, (route) => route.fulfill({ status: 404 }));
  await context.route(/\/files\/(setup\.exe|system\.iso)$/, (route) => route.fulfill({
    contentType: 'application/octet-stream',
    headers: { 'content-disposition': `attachment; filename="${route.request().url().split('/').pop()}"` },
    body: '下载测试数据',
  }));

  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await page.goto(site);
  await page.addScriptTag({ url: `/extension/${loader}` });
  await page.waitForFunction(() => globalThis.devpilotReady, undefined, { timeout: 5000 });
  await page.getByRole('link', { name: '查看 SQL' }).click({ noWaitAfter: true, timeout: 5000 });
  const preview = page.getByRole('dialog', { name: 'migration.SQL' });
  const sql = preview.locator('pre');
  await sql.waitFor();
  assert.equal(await sql.textContent(), source);
  const tokenColor = async (code, pattern) => {
    const token = code.locator('span').filter({ hasText: pattern }).first();
    await token.waitFor();
    return token.evaluate((element) => globalThis.getComputedStyle(element).color);
  };
  const colors = await Promise.all([/^CREATE TABLE$/, /^DATETIME$/, /^20$/, /^-- 示例$/, /^'<script>/, /^`id`$/]
    .map((pattern) => tokenColor(sql, pattern)));
  assert.equal(new Set(colors).size, colors.length);
  assert.equal(await tokenColor(sql, /^AUTO_INCREMENT$/), colors[0]);
  assert.equal(await tokenColor(sql, /^BIGINT$/), colors[1]);
  assert.equal(await sql.locator('script').count(), 0);
  assert.equal(await sql.textContent(), source);
  assert.equal(downloads.length, 0);
  assert.equal(page.url(), `${site}/`);
  const saved = page.waitForEvent('download');
  await preview.getByRole('button', { name: '下载文件' }).click();
  const attachment = await saved;
  assert.equal(attachment.suggestedFilename(), 'migration.SQL');
  assert.equal(attachment.url(), `${site}/files/migration.SQL`);
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'detached' });

  await page.getByRole('link', { name: '查看 Java' }).click();
  const java = page.getByRole('dialog', { name: 'Demo.java' });
  const javaCode = java.locator('pre');
  assert.notEqual(await tokenColor(javaCode, /^public$/), await tokenColor(javaCode, /^"示例"$/));
  assert.equal(await javaCode.textContent(), javaSource);
  await java.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('link', { name: '查看文本' }).click();
  const notes = page.getByRole('dialog', { name: 'notes.txt' });
  const plain = notes.locator('pre');
  await plain.waitFor();
  assert.equal(await plain.textContent(), plainSource);
  assert.equal(await plain.locator('span').count(), 0);
  await notes.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('link', { name: '查看大文件' }).click();
  const long = page.getByRole('dialog', { name: 'long.sql' });
  const longCode = long.locator('pre');
  await tokenColor(longCode, /^SELECT$/);
  assert.equal(await longCode.locator('span').filter({ hasText: /DROP/ }).count(), 0);
  assert.equal(await longCode.textContent(), longSource);
  await long.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('link', { name: '查看图片' }).click({ noWaitAfter: true });
  const photo = page.getByRole('dialog', { name: 'photo.png' });
  await photo.getByRole('img', { name: 'photo.png' }).waitFor();
  assert.equal(await photo.getByRole('img').evaluate((image) => image.decode().then(() => image.naturalWidth)), 1);
  assert.equal(downloads.length, 1);
  await photo.getByRole('button', { name: '关闭' }).click();

  const videoData = await page.evaluate(async () => {
    const canvas = globalThis.document.createElement('canvas');
    const drawing = canvas.getContext('2d');
    const stream = canvas.captureStream(30);
    const recorder = new globalThis.MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const data = new Promise((resolve) => recorder.addEventListener('dataavailable', ({ data }) => resolve(data.arrayBuffer()), { once: true }));
    recorder.start();
    drawing.fillRect(0, 0, 10, 10);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    recorder.stop();
    for (const track of stream.getTracks()) track.stop();
    return Array.from(new Uint8Array(await data));
  });
  await context.route(`${site}/api/file?id=42&fileName=clip.webm`, (route) => route.fulfill({
    contentType: 'video/webm',
    headers: { 'content-disposition': 'attachment; filename="clip.webm"' },
    body: Buffer.from(videoData),
  }));
  await page.getByRole('link', { name: '查看视频' }).click({ noWaitAfter: true });
  const video = page.getByRole('dialog', { name: 'clip.webm' });
  const player = video.locator('video');
  await video.getByText('正在加载预览…').waitFor({ state: 'hidden' });
  assert.equal(await player.evaluate((media) => media.readyState >= 1 && media.controls), true);
  assert.equal(downloads.length, 1);
  await video.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('link', { name: '失效附件' }).click({ noWaitAfter: true });
  const missing = page.getByRole('dialog', { name: 'missing.webm' });
  await missing.getByText('无法加载预览，你仍可下载文件。').waitFor();
  assert.equal(await missing.getByRole('button', { name: '下载文件' }).isEnabled(), true);
  await missing.getByRole('button', { name: '关闭' }).click();

  for (const label of ['安装包', '镜像']) {
    const direct = page.waitForEvent('download', { timeout: 5000 });
    await page.getByRole('link', { name: label }).click({ noWaitAfter: true });
    await direct;
    assert.equal(await page.getByRole('dialog').count(), 0);
  }
  await page.getByRole('link', { name: '跨站图片' }).click();
  const remote = page.getByRole('dialog', { name: 'remote.png' });
  await remote.getByRole('img', { name: 'remote.png' }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.downloadRequest), undefined);
  await remote.getByRole('button', { name: '下载文件' }).click({ noWaitAfter: true });
  await page.waitForFunction(() => globalThis.downloadRequest?.url === 'https://files.test/remote.png');
  assert.equal(page.url(), `${site}/`);
  process.stdout.write('网页点击预览与主动下载验证通过\n');
} finally {
  await browser.close();
}
