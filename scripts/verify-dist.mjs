import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(projectRoot, 'dist');
const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
const loader = await readFile(resolve(dist, manifest.background.service_worker), 'utf8');
const importedPath = loader.match(/import\s+['"](.+?)['"]/u)?.[1];

if (!importedPath) {
  throw new Error('无法定位 Service Worker 构建入口');
}

const workerEntry = resolve(dist, importedPath);
const modulePattern = /\b(?:import|export)(?:[^'"]*?\bfrom)?\s*['"](.+?)['"]/gu;
const workerModules = new Map();

const collectModules = async (file) => {
  if (workerModules.has(file)) return;
  const code = await readFile(file, 'utf8');
  workerModules.set(file, code);
  for (const match of code.matchAll(modulePattern)) {
    if (match[1].startsWith('.')) {
      await collectModules(resolve(dirname(file), match[1]));
    }
  }
};

await collectModules(workerEntry);
for (const [file, code] of workerModules) {
  if (/\b(?:window|document|HTMLInputElement|HTMLSelectElement)\b/u.test(code)) {
    throw new Error(`Service Worker 依赖错误包含 DOM 代码：${file}`);
  }
}

const contentFiles = manifest.content_scripts.flatMap((entry) => entry.js ?? []);
if (contentFiles.includes(importedPath.replace(/^\.\//u, ''))) {
  throw new Error('Service Worker 与 Content Script 错误指向同一构建文件');
}

const event = { addListener() {} };
globalThis.chrome = {
  commands: { onCommand: event },
  contextMenus: { create() {}, onClicked: event, removeAll: async () => {} },
  runtime: { onInstalled: event, onMessage: event },
  sidePanel: { open: async () => {} },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { set: async () => {} },
  },
  tabs: { query: async () => [], sendMessage: async () => ({ ok: true }) },
};
await import(`${pathToFileURL(workerEntry).href}?verify=${Date.now()}`);

console.log(`扩展产物检查通过：${workerModules.size} 个后台模块无 DOM 依赖且可初始化`);
