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
  | 'radio'
  | 'switch';

export type FormValue = string | boolean | string[] | null;

export interface ReplacementRule {
  enabled?: boolean;
  mode: 'text' | 'regex';
  search: string;
  replacement: string;
}

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
  /** 随当前表单记录保存，模板渲染后按顺序替换，不改写原始值。 */
  replacementRules?: ReplacementRule[];
  required?: boolean;
  disabled?: boolean;
  metadata?: Record<string, string>;
}

/**
 * 源字段的匹配线索：目标字段因联动重渲染换了 key 时，仍能按语义找回同一字段。
 * 只保留参与打分的属性，避免消息体带上值等无关数据。
 */
export type FieldDescriptor = Pick<
  FormField,
  'type' | 'label' | 'name' | 'id' | 'placeholder' | 'ariaLabel' | 'selector'
>;

export interface FormSource {
  url: string;
  title?: string;
  host: string;
}

export interface FormScanResult {
  suggestedName?: string;
  source: FormSource;
  fields: FormField[];
  /** 内容脚本为本次文档生成的作用域标识；只在当前页面会话与消息中使用，不写入历史。 */
  scopeId?: string;
}

export interface FormTargetSnapshot {
  url: string;
  fingerprint: string;
  /** 与扫描时相同的作用域标识；填充时用它找回同一个表单容器。 */
  scopeId?: string;
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
  /** 不参与粘贴的字段 key；预览与一键填充都会跳过，详情页可随时改。 */
  excludedFieldKeys?: string[];
  pinned?: boolean;
  fingerprint: string;
}

export interface FormClipboardDetails {
  name: string;
  fields: FormField[];
  uniqueFieldKeys: string[];
  excludedFieldKeys: string[];
  pinned: boolean;
}

export interface ClipboardTemplate {
  id: string;
  name: string;
  fieldValues: Record<string, string>;
}

export interface FormClipboardSettings {
  historyLimit: number | null;
  /** 替换总开关，旧配置缺省关闭；关闭时全局和字段规则均不执行。 */
  replacementEnabled?: boolean;
  replacementRules?: ReplacementRule[];
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

export type DiffStatus = 'UNCHANGED' | 'CHANGED' | 'UNIQUE' | 'UNMATCHED' | 'HELD';

export interface FieldDiff {
  source: FormField;
  target?: FormField;
  originalValue: FormValue;
  nextValue: FormValue;
  status: DiffStatus;
  score: number;
}

export interface FieldAssignment {
  /** 目标字段 key；延迟填充（sourceKey 有值）时为空串，只按描述符定位。 */
  targetKey: string;
  targetSelector?: string;
  label: string;
  value: FormValue;
  /** 源下拉的底层真实值；远程搜索时优先用它作为检索词。 */
  searchKey?: string;
  /** 目标字段因联动重渲染换了 key 时，用它重新定位；旧消息缺省时回退到 targetKey。 */
  descriptor?: FieldDescriptor;
  /** 延迟填充的源字段 key；目标表单当前还没渲染该字段，填充阶段重扫后再定位。 */
  sourceKey?: string;
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
