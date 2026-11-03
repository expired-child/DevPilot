import { SHORTCUT_ACTIONS, SHORTCUT_BINDINGS_REQUEST, type ShortcutAction } from '../shared/constants';

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
 * 仅在 Chrome 命令没有绑定快捷键时启用页面兜底。
 * 用户重新绑定命令后，原来的 Alt+Shift+C/V 不再拦截网页按键。
 */
export const registerPageShortcuts = (onError: (message: string) => void): (() => void) => {
  let fallbackCopy = false;
  let fallbackPaste = false;
  void chrome.runtime.sendMessage({ type: SHORTCUT_BINDINGS_REQUEST })
    .then((response: { ok?: boolean; fallbackCopy?: boolean; fallbackPaste?: boolean } | undefined) => {
      if (response?.ok) {
        fallbackCopy = Boolean(response.fallbackCopy);
        fallbackPaste = Boolean(response.fallbackPaste);
      }
    })
    .catch(() => {});

  const handleKeyDown = (event: KeyboardEvent): void => {
    const action = resolvePageShortcut(event);
    if (!action || (action === SHORTCUT_ACTIONS.copy ? !fallbackCopy : !fallbackPaste)) return;
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
  };
  window.addEventListener('keydown', handleKeyDown, true);
  return () => window.removeEventListener('keydown', handleKeyDown, true);
};
