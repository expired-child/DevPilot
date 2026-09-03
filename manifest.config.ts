import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'DevPilot',
  description: '面向开发者的浏览器效率工具，首个模块为表单剪贴板。',
  version: '0.1.7',
  minimum_chrome_version: '114',
  permissions: ['activeTab', 'contextMenus', 'sidePanel', 'storage'],
  action: {
    default_title: '打开 DevPilot',
    default_popup: 'sidepanel.html',
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'sidepanel.html',
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
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
      description: '一键粘贴最近表单到当前页',
    },
  },
});
