import type { ClipboardRepository } from './clipboard-repository';
import type {
  FormClipboardItem,
  FormClipboardDetails,
  FormClipboardState,
  FormScanResult,
  ReplacementRule,
} from './clipboard-types';
import { createFingerprint } from './fingerprint';
import { sameReplacementRules, validateReplacementRules } from './replacement-service';

const ruleKey = (host: string, fieldKey: string): string => `${host}::${fieldKey}`;

export const sortHistory = (history: FormClipboardItem[]): FormClipboardItem[] =>
  [...history].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) {
      return left.pinned ? -1 : 1;
    }
    return right.updatedAt - left.updatedAt;
  });

const fallbackName = (timestamp: number): string => {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `未命名表单 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export class ClipboardService {
  constructor(
    private readonly repository: ClipboardRepository,
    private readonly now: () => number = Date.now,
  ) {}

  getState(): Promise<FormClipboardState> {
    return this.repository.get();
  }

  async capture(scan: FormScanResult): Promise<FormClipboardItem> {
    const state = await this.repository.get();
    const timestamp = this.now();
    const fingerprint = createFingerprint(scan.source.host, scan.fields);
    const current = state.history.find((item) => item.id === state.currentId);

    if (current?.fingerprint === fingerprint) {
      const updated = { ...current, updatedAt: timestamp, source: scan.source };
      state.history = sortHistory(state.history.map((item) => (item.id === updated.id ? updated : item)));
      await this.repository.save(state);
      return updated;
    }

    const uniqueFieldKeys = scan.fields
      .filter((field) => state.fieldRules[ruleKey(scan.source.host, field.key)]?.unique)
      .map((field) => field.key);
    const item: FormClipboardItem = {
      id: crypto.randomUUID(),
      name: scan.suggestedName?.trim() || fallbackName(timestamp),
      createdAt: timestamp,
      updatedAt: timestamp,
      source: scan.source,
      fields: scan.fields,
      uniqueFieldKeys,
      fingerprint,
    };

    state.currentId = item.id;
    state.history = this.trimHistory(sortHistory([item, ...state.history]), state.settings.historyLimit);
    await this.repository.save(state);
    return item;
  }

  async saveDetails(id: string, details: FormClipboardDetails): Promise<FormClipboardItem> {
    for (const field of details.fields) {
      const error = validateReplacementRules(field.replacementRules);
      if (error) throw new Error(`${field.label || field.name || field.key}：${error}`);
    }
    const state = await this.repository.get();
    const item = state.history.find((entry) => entry.id === id);
    if (!item) throw new Error('表单记录已不存在，请返回历史重新选择。');

    const fieldKeys = new Set(item.fields.map((field) => field.key));
    const uniqueFieldKeys = [...new Set(details.uniqueFieldKeys)].filter((key) => fieldKeys.has(key));
    const excludedFieldKeys = [...new Set(details.excludedFieldKeys)].filter((key) => fieldKeys.has(key));
    const previousUnique = new Set(item.uniqueFieldKeys ?? []);
    const nextUnique = new Set(uniqueFieldKeys);
    for (const key of fieldKeys) {
      if (previousUnique.has(key) !== nextUnique.has(key)) {
        state.fieldRules[ruleKey(item.source.host, key)] = { unique: nextUnique.has(key) };
      }
    }

    const updated: FormClipboardItem = {
      ...item,
      name: details.name.trim() || item.name,
      fields: details.fields,
      uniqueFieldKeys,
      excludedFieldKeys,
      pinned: details.pinned,
      fingerprint: createFingerprint(item.source.host, details.fields),
      updatedAt: this.now(),
    };
    state.history = sortHistory(state.history.map((entry) => entry.id === id ? updated : entry));
    await this.repository.save(state);
    return updated;
  }

  async remove(id: string): Promise<void> {
    const state = await this.repository.get();
    state.history = sortHistory(state.history.filter((item) => item.id !== id));
    if (state.currentId === id) {
      state.currentId = [...state.history].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? null;
    }
    await this.repository.save(state);
  }

  async clear(): Promise<void> {
    const state = await this.repository.get();
    state.currentId = null;
    state.history = [];
    await this.repository.save(state);
  }

  async setReplacementEnabled(enabled: boolean): Promise<void> {
    const state = await this.repository.get();
    state.settings.replacementEnabled = enabled;
    await this.repository.save(state);
  }

  async saveReplacementRules(rules: ReplacementRule[], expectedRules: ReplacementRule[]): Promise<void> {
    const error = validateReplacementRules(rules);
    if (error) throw new Error(error);
    const state = await this.repository.get();
    if (!sameReplacementRules(state.settings.replacementRules ?? [], expectedRules)) {
      throw new Error('全局规则已在其他窗口更新，请核对当前规则后重试。');
    }
    state.settings.replacementRules = rules;
    await this.repository.save(state);
  }

  private trimHistory(
    history: FormClipboardItem[],
    limit: FormClipboardState['settings']['historyLimit'],
  ): FormClipboardItem[] {
    if (limit === null || history.length <= limit) {
      return history;
    }

    const result = [...history];
    while (result.length > limit) {
      const removableIndex = result.map((item) => !item.pinned).lastIndexOf(true);
      if (removableIndex < 0) {
        break;
      }
      result.splice(removableIndex, 1);
    }
    return result;
  }
}

export const searchHistory = (items: FormClipboardItem[], query: string): FormClipboardItem[] => {
  const keyword = query.trim().toLocaleLowerCase();
  if (!keyword) {
    return items;
  }

  return items.filter((item) =>
    [
      item.name,
      item.source.host,
      item.source.title ?? '',
      ...item.fields.flatMap((field) => [
        field.label ?? '',
        field.name ?? '',
        field.id ?? '',
        field.placeholder ?? '',
        Array.isArray(field.value) ? field.value.join(' ') : String(field.value ?? ''),
      ]),
    ].some((value) => value.toLocaleLowerCase().includes(keyword)),
  );
};
