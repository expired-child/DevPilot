import { SHORTCUT_ACTIONS, type ShortcutAction } from '../shared/constants';

interface KeyboardShortcutLike {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}

export const resolvePageShortcut = (event: KeyboardShortcutLike): ShortcutAction | null => {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.repeat) {
    return null;
  }
  const key = event.key.toLocaleLowerCase();
  if (key === 'c') return SHORTCUT_ACTIONS.copy;
  if (key === 'v') return SHORTCUT_ACTIONS.paste;
  return null;
};

/**
 * 页面级 keydown 兜底：Chrome 命令未绑定或被占用时仍能触发复制/粘贴。
 * 注意 content script 里无法访问 chrome.commands（不可查询绑定状态），
 * 因此可能与命令通道同时触发，重复执行由 Service Worker 的 claimAction 去重窗口拦截。
 */
export const registerPageShortcuts = (onError: (message: string) => void): void => {
  window.addEventListener(
    'keydown',
    (event) => {
      const action = resolvePageShortcut(event);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      void chrome.runtime
        .sendMessage({ type: action })
        .then((response: { ok?: boolean; error?: string } | undefined) => {
          if (response?.ok === false) {
            onError(response.error ?? '快捷键执行失败');
          }
        })
        .catch(() => onError('快捷键执行失败，请重新加载扩展和当前页面'));
    },
    true,
  );
};
