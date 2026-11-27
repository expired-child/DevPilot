import { defineManifest } from '@crxjs/vite-plugin';

const formContentScript = {
  matches: ['http://*/*', 'https://*/*'],
  js: ['src/content/index.ts' as const],
  all_frames: true,
  match_about_blank: true,
  match_origin_as_fallback: true,
  run_at: 'document_idle' as const,
};

const icons = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

export default defineManifest({
  manifest_version: 3,
  name: 'DevPilot',
  description: '面向开发者的浏览器效率工具，支持表单剪贴板、书签搜索、网页文件预览和网页成书。',
  version: '0.1.9',
  minimum_chrome_version: '141',
  permissions: ['activeTab', 'bookmarks', 'contextMenus', 'downloads', 'sidePanel', 'storage', 'webNavigation'],
  icons,
  action: {
    default_title: '打开 DevPilot 侧栏',
    default_icon: icons,
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
