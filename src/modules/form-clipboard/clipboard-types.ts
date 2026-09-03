export type FieldType =
  | 'text'
  | 'number'
  | 'email'
  | 'url'
  | 'tel'
  | 'date'
  | 'datetime-local'
  | 'time'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio';

export type FormValue = string | boolean | string[] | null;

export interface FormField {
  key: string;
  label?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  selector?: string;
  type: FieldType;
  value: FormValue;
  required?: boolean;
  disabled?: boolean;
  metadata?: Record<string, string>;
}

export interface FormSource {
  url: string;
  title?: string;
  host: string;
}

export interface FormScanResult {
  suggestedName?: string;
  source: FormSource;
  fields: FormField[];
}

export interface FormClipboardItem {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  source: FormSource;
  fields: FormField[];
  variables?: Record<string, string>;
  uniqueFieldKeys?: string[];
  pinned?: boolean;
  fingerprint: string;
}

export interface ClipboardTemplate {
  id: string;
  name: string;
  fieldValues: Record<string, string>;
}

export interface FormClipboardSettings {
  historyLimit: number | null;
}

export interface FieldRule {
  unique: boolean;
}

export interface FormClipboardState {
  currentId: string | null;
  history: FormClipboardItem[];
  settings: FormClipboardSettings;
  fieldRules: Record<string, FieldRule>;
  templates: ClipboardTemplate[];
}

export interface FieldMatch {
  source: FormField;
  target?: FormField;
  score: number;
  reasons: string[];
}

export type DiffStatus = 'UNCHANGED' | 'CHANGED' | 'UNIQUE' | 'UNMATCHED';

export interface FieldDiff {
  source: FormField;
  target?: FormField;
  originalValue: FormValue;
  nextValue: FormValue;
  status: DiffStatus;
  score: number;
}

export interface FieldAssignment {
  targetKey: string;
  targetSelector?: string;
  label: string;
  value: FormValue;
}

export interface FillIssue {
  label: string;
  reason: string;
}

export interface FillReport {
  success: number;
  skipped: number;
  failed: number;
  issues: FillIssue[];
}
