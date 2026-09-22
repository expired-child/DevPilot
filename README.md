# DevPilot

DevPilot 是一个可扩展的 Chrome 开发者效率插件。当前版本提供独立的 **Form Clipboard / 表单剪贴板** 模块。

## 开发

```bash
npm install
npx playwright install chromium
npm run lint
npm run typecheck
npm test
npm run build
```

构建产物位于 `dist/`。在 Chrome 打开 `chrome://extensions`，启用“开发者模式”，点击“加载已解压的扩展程序”并选择 `dist`。

测试使用真实 Chromium DOM，覆盖弹窗与多表单选择、隐藏页签、重复字段、复制粘贴往返和联动重渲染。

## 快捷键

- `Alt + Shift + C`：复制当前表单
- `Alt + Shift + V`：一键把最近复制的表单填充到当前页（不打开面板，页内 toast 汇总结果；唯一字段自动追加 `-2`/`-3` 后缀避免重复）

快捷键冲突时可在 `chrome://extensions/shortcuts` 修改。

复制和粘贴优先操作可见弹窗；普通页面有多个表单时，先点一下目标表单内的输入框。更新插件后，在扩展管理页重新加载插件并刷新业务网页，再重新复制源表单；此前已经复制错的历史记录不会自动恢复。

编辑弹窗内复用带 `query-form` / `filter-form` 类名的组件时，仍会采集业务字段；弹窗外的查询表单、分页与全局搜索区域，以及隐藏和敏感字段仍按原规则过滤。

## 隐私与安全

表单数据仅保存在 `chrome.storage.local`。插件不会上传数据、自动提交表单或点击确认按钮；密码、验证码、Token、Secret、API Key、信用卡及文件字段默认排除。
