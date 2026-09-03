import type { ClipboardRepository } from './clipboard-repository';
import type {
  FormClipboardItem,
  FormClipboardState,
  FormField,
  FormScanResult,
} from './clipboard-types';
import { createFingerprint } from './fingerprint';

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

  async getCurrent(): Promise<FormClipboardItem | null> {
    const state = await this.repository.get();
    return state.history.find((item) => item.id === state.currentId) ?? null;
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

  async rename(id: string, name: string): Promise<void> {
    await this.updateItem(id, (item) => ({ ...item, name: name.trim() || item.name }));
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

  async togglePin(id: string): Promise<void> {
    await this.updateItem(id, (item) => ({ ...item, pinned: !item.pinned }));
  }

  async saveFields(id: string, fields: FormField[]): Promise<void> {
    await this.updateItem(id, (item) => ({
      ...item,
      fields,
      fingerprint: createFingerprint(item.source.host, fields),
    }));
  }

  async setUniqueField(id: string, fieldKey: string, unique: boolean): Promise<void> {
    const state = await this.repository.get();
    const item = state.history.find((entry) => entry.id === id);
    if (!item) {
      return;
    }

    const keys = new Set(item.uniqueFieldKeys ?? []);
    if (unique) {
      keys.add(fieldKey);
    } else {
      keys.delete(fieldKey);
    }
    item.uniqueFieldKeys = [...keys];
    state.fieldRules[ruleKey(item.source.host, fieldKey)] = { unique };
    await this.repository.save(state);
  }

  private async updateItem(
    id: string,
    updater: (item: FormClipboardItem) => FormClipboardItem,
  ): Promise<void> {
    const state = await this.repository.get();
    const timestamp = this.now();
    state.history = sortHistory(
      state.history.map((item) =>
        item.id === id ? { ...updater(item), updatedAt: timestamp } : item,
      ),
    );
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
