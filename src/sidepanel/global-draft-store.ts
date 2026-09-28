import type { ReplacementRule } from '../modules/form-clipboard/clipboard-types';
import { sameReplacementRules } from '../modules/form-clipboard/replacement-service';

/**
 * 未应用的全局规则草稿存 chrome.storage.session，按窗口区分；
 * storage.session 在浏览器重启、扩展重载或更新时清除，
 * 只承担本次浏览器会话内的草稿恢复，不改变正式规则的持久化位置。
 */
export interface GlobalDraftRecord {
  /** 草稿开始编辑时的正式规则；恢复时用于判断正式规则是否已被其他窗口更新。 */
  baseRules: ReplacementRule[];
  draft: ReplacementRule[];
  savedAt: number;
}

export const globalDraftKey = (windowId: number): string => `globalReplacementDraft:${windowId}`;

export const sameRules = sameReplacementRules;

const pendingWrites = new Map<number, Promise<void>>();

export const loadGlobalDraft = async (windowId: number): Promise<GlobalDraftRecord | null> => {
  await pendingWrites.get(windowId)?.catch(() => {});
  const key = globalDraftKey(windowId);
  const stored = (await chrome.storage.session.get(key))[key] as GlobalDraftRecord | undefined;
  if (!stored || !Array.isArray(stored.draft) || !Array.isArray(stored.baseRules)) return null;
  return stored;
};

export const saveGlobalDraft = (windowId: number, record: GlobalDraftRecord | null): Promise<void> => {
  const previous = pendingWrites.get(windowId) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const key = globalDraftKey(windowId);
    if (record) await chrome.storage.session.set({ [key]: record });
    else await chrome.storage.session.remove(key);
  });
  pendingWrites.set(windowId, task);
  const release = (): void => { if (pendingWrites.get(windowId) === task) pendingWrites.delete(windowId); };
  void task.then(release, release);
  return task;
};

/** 返回当前窗口 id；找不到窗口（如测试环境）时返回 null。 */
export const currentWindowId = async (): Promise<number | null> => {
  try {
    const window = await chrome.windows.getCurrent();
    return typeof window?.id === 'number' ? window.id : null;
  } catch {
    return null;
  }
};
