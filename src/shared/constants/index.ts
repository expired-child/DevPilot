export const COMMANDS = {
  copy: 'copy-current-form',
  paste: 'paste-latest-form',
  openBookmarks: 'open-bookmark-search',
} as const;

export const SHORTCUT_ACTIONS = {
  copy: 'COPY_CURRENT_FORM',
  paste: 'PASTE_LATEST_FORM',
  openBookmarks: 'OPEN_BOOKMARK_SEARCH',
} as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[keyof typeof SHORTCUT_ACTIONS];

export const SHORTCUT_BINDINGS_REQUEST = 'GET_SHORTCUT_BINDINGS';

/** storage.session 中的标记键：目标窗口的侧栏读到后跳转书签搜索页。 */
export const BOOKMARK_SEARCH_TRIGGER = 'openBookmarkSearch';

export interface BookmarkSearchTrigger {
  windowId: number;
  requestId: string;
}

export const CONTEXT_MENUS = {
  root: 'devpilot-root',
  copy: 'devpilot-copy-form',
  paste: 'devpilot-paste-form',
} as const;
