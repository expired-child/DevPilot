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
