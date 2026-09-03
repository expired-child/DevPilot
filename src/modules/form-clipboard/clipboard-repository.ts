import type { FormClipboardState } from './clipboard-types';

export const STORAGE_KEY = 'formClipboard';

export const defaultClipboardState = (): FormClipboardState => ({
  currentId: null,
  history: [],
  settings: { historyLimit: 50 },
  fieldRules: {},
  templates: [],
});

export interface ClipboardRepository {
  get(): Promise<FormClipboardState>;
  save(state: FormClipboardState): Promise<void>;
}

export class ChromeClipboardRepository implements ClipboardRepository {
  async get(): Promise<FormClipboardState> {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as
      | Partial<FormClipboardState>
      | undefined;
    const defaults = defaultClipboardState();

    return {
      ...defaults,
      ...stored,
      settings: { ...defaults.settings, ...stored?.settings },
      history: Array.isArray(stored?.history) ? stored.history : [],
      fieldRules: stored?.fieldRules ?? {},
      templates: Array.isArray(stored?.templates) ? stored.templates : [],
    };
  }

  async save(state: FormClipboardState): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  }
}
