import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

const extensionPath = path.resolve('dist');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

try {
  await context.route('https://main.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<main><h1>Main frame</h1><iframe src="https://child.test/form"></iframe></main>',
  }));
  await context.route('https://child.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<form><input name="username" value="child"><div id="notes" contenteditable="true">draft</div></form>',
  }));

  const page = await context.newPage();
  await page.goto('https://main.test/form');
  await page.frameLocator('iframe').locator('input[name="username"]').waitFor();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const scanned = await worker.evaluate(async () => {
    const [tab] = await globalThis.chrome.tabs.query({ active: true, currentWindow: true });
    const frames = await globalThis.chrome.webNavigation.getAllFrames({ tabId: tab.id });
    return Promise.all(frames.map(async ({ frameId, documentId }) => {
      try {
        const response = await globalThis.chrome.tabs.sendMessage(tab.id, { type: 'SCAN_FORM' }, { documentId });
        return { frameId, documentId, response };
      } catch (error) {
        return { frameId, documentId, error: String(error) };
      }
    }));
  });
  const main = scanned.find(({ frameId }) => frameId === 0);
  const child = scanned.find(({ frameId }) => frameId !== 0);
  assert.deepEqual(main?.response?.scan?.fields, []);
  assert.deepEqual(child?.response?.scan?.fields.map(({ value }) => value), ['child', 'draft']);

  const report = await worker.evaluate(async ({ documentId, assignments }) => {
    const [tab] = await globalThis.chrome.tabs.query({ active: true, currentWindow: true });
    return globalThis.chrome.tabs.sendMessage(tab.id, { type: 'APPLY_FIELDS', assignments }, { documentId });
  }, {
    documentId: child.documentId,
    assignments: child.response.scan.fields.map((field) => ({
      targetKey: field.key,
      label: field.name ?? field.id,
      value: field.name === 'username' ? 'updated' : 'new notes',
    })),
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.report, { success: 2, skipped: 0, failed: 0, issues: [] });
  assert.equal(await page.frameLocator('iframe').locator('input[name="username"]').inputValue(), 'updated');
  assert.equal(await page.frameLocator('iframe').locator('#notes').innerText(), 'new notes');
  process.stdout.write('iframe scan and document-targeted fill passed\n');
} finally {
  await context.close();
}
