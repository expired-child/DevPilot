export const PENDING_PASTE_KEY = 'devpilotPendingPasteItemId';

export const COMMANDS = {
  copy: 'copy-current-form',
  paste: 'paste-latest-form',
} as const;

export const SHORTCUT_ACTIONS = {
  copy: 'COPY_CURRENT_FORM',
  paste: 'PASTE_LATEST_FORM',
} as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[keyof typeof SHORTCUT_ACTIONS];

export const CONTEXT_MENUS = {
  root: 'devpilot-root',
  copy: 'devpilot-copy-form',
  paste: 'devpilot-paste-form',
} as const;
