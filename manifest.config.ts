import { defineManifest } from '@crxjs/vite-plugin';

const formContentScript = {
  matches: ['http://*/*', 'https://*/*'],
  js: ['src/content/index.ts' as const],
  all_frames: true,
  match_about_blank: true,
  match_origin_as_fallback: true,
  run_at: 'document_idle' as const,
};

export default defineManifest({
  manifest_version: 3,
  name: 'DevPilot',
  description: '面向开发者的浏览器效率工具，首个模块为表单剪贴板。',
  version: '0.1.8',
  minimum_chrome_version: '141',
  permissions: ['activeTab', 'bookmarks', 'contextMenus', 'sidePanel', 'storage', 'webNavigation'],
  action: {
    default_title: '打开 DevPilot 侧栏',
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'sidepanel.html',
  },
  content_scripts: [formContentScript],
  commands: {
    'copy-current-form': {
      suggested_key: {
        default: 'Alt+Shift+C',
      },
      description: '复制当前页面表单',
    },
    'paste-latest-form': {
      suggested_key: {
        default: 'Alt+Shift+V',
      },
      description: '直接填充最近表单到当前页（跳过预览）',
    },
    'open-bookmark-search': {
      suggested_key: {
        default: 'Alt+Shift+F',
      },
      description: '打开书签搜索',
    },
  },
});
