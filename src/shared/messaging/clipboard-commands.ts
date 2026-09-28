import type {
  FormClipboardDetails,
  FormClipboardItem,
  FormField,
  FormScanResult,
  ReplacementRule,
} from '../../modules/form-clipboard/clipboard-types';

/**
 * 侧栏等扩展页面唯一的写入口：每条命令由后台协调器串行执行，
 * 侧栏不再直接调用 repository.save，避免跨上下文并发写入互相覆盖。
 */
export const CLIPBOARD_COMMANDS = {
  capture: 'CAPTURE_FORM',
  saveDetails: 'SAVE_DETAILS',
  removeItem: 'REMOVE_ITEM',
  clearHistory: 'CLEAR_HISTORY',
  setReplacementEnabled: 'SET_REPLACEMENT_ENABLED',
  saveReplacementRules: 'SAVE_REPLACEMENT_RULES',
} as const;

export type ClipboardCommand =
  | { type: typeof CLIPBOARD_COMMANDS.capture; scan: FormScanResult }
  | { type: typeof CLIPBOARD_COMMANDS.saveDetails; id: string; details: FormClipboardDetails }
  | { type: typeof CLIPBOARD_COMMANDS.removeItem; id: string }
  | { type: typeof CLIPBOARD_COMMANDS.clearHistory }
  | { type: typeof CLIPBOARD_COMMANDS.setReplacementEnabled; enabled: boolean }
  | { type: typeof CLIPBOARD_COMMANDS.saveReplacementRules; rules: ReplacementRule[]; expectedRules: ReplacementRule[] };

export type ClipboardCommandResult =
  | { ok: true; item?: FormClipboardItem }
  | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';
const isOptionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean';
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const FIELD_TYPES = new Set<FormField['type']>([
  'text', 'number', 'email', 'url', 'tel', 'date', 'datetime-local', 'time',
  'textarea', 'select', 'checkbox', 'radio', 'switch',
]);

const isField = (value: unknown): value is FormField =>
  isRecord(value) && typeof value.key === 'string' && value.key.length > 0 &&
  FIELD_TYPES.has(value.type as FormField['type']) &&
  (typeof value.value === 'string' || typeof value.value === 'boolean' || value.value === null || isStringArray(value.value)) &&
  ['label', 'name', 'id', 'placeholder', 'ariaLabel', 'selector'].every((key) => isOptionalString(value[key])) &&
  isOptionalBoolean(value.required) && isOptionalBoolean(value.disabled) &&
  (value.replacementRules === undefined || isReplacementRules(value.replacementRules)) &&
  (value.metadata === undefined || (isRecord(value.metadata) && Object.values(value.metadata).every((entry) => typeof entry === 'string')));

const isFormScanResult = (value: unknown): value is FormScanResult =>
  isRecord(value) && isRecord(value.source) && typeof value.source.url === 'string' &&
  typeof value.source.host === 'string' && isOptionalString(value.source.title) &&
  isOptionalString(value.suggestedName) && isOptionalString(value.scopeId) &&
  Array.isArray(value.fields) && value.fields.every(isField);

const isReplacementRules = (value: unknown): value is ReplacementRule[] =>
  Array.isArray(value) && value.every((rule) =>
    isRecord(rule) && (rule.mode === 'text' || rule.mode === 'regex') &&
    typeof rule.search === 'string' && typeof rule.replacement === 'string' &&
    isOptionalBoolean(rule.enabled));

const isClipboardDetails = (value: unknown): value is FormClipboardDetails =>
  isRecord(value) && typeof value.name === 'string' && Array.isArray(value.fields) && value.fields.every(isField) &&
  isStringArray(value.uniqueFieldKeys) && isStringArray(value.excludedFieldKeys) &&
  typeof value.pinned === 'boolean';

/** 只接受预期命令和完整参数，未知类型一律拒绝。 */
export const isClipboardCommand = (value: unknown): value is ClipboardCommand => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case CLIPBOARD_COMMANDS.capture:
      return isFormScanResult(value.scan);
    case CLIPBOARD_COMMANDS.saveDetails:
      return typeof value.id === 'string' && value.id.length > 0 && isClipboardDetails(value.details);
    case CLIPBOARD_COMMANDS.removeItem:
      return typeof value.id === 'string' && value.id.length > 0;
    case CLIPBOARD_COMMANDS.clearHistory:
      return true;
    case CLIPBOARD_COMMANDS.setReplacementEnabled:
      return typeof value.enabled === 'boolean';
    case CLIPBOARD_COMMANDS.saveReplacementRules:
      return isReplacementRules(value.rules) && isReplacementRules(value.expectedRules);
    default:
      return false;
  }
};

export const sendClipboardCommand = async (command: ClipboardCommand): Promise<ClipboardCommandResult> =>
  chrome.runtime.sendMessage(command) as Promise<ClipboardCommandResult>;

export const commandErrorText = (response: ClipboardCommandResult): string =>
  response.ok ? '' : response.error;
