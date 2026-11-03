import type {
  FieldAssignment,
  FillReport,
  FormScanResult,
  FormSource,
  FormTargetSnapshot,
} from '../../modules/form-clipboard/clipboard-types';

/** 候选表单概要：只含标题、数量与少量标签，绝不携带字段值。 */
export interface FormCandidateSummary {
  scopeId: string;
  title?: string;
  fieldCount: number;
  fieldLabels: string[];
  /** 作用域命中弹窗容器（当前操作边界）。 */
  dialog: boolean;
  /** 焦点在该作用域内。 */
  focused: boolean;
  source: FormSource;
}

export type ContentRequest =
  | { type: 'SCAN_FORM'; scopeId?: string }
  | { type: 'LIST_FORM_CANDIDATES' }
  | { type: 'APPLY_FIELDS'; assignments: FieldAssignment[]; expectedTarget?: FormTargetSnapshot }
  | { type: 'SHOW_TOAST'; message: string; tone?: 'success' | 'error' };

export type ContentResponse =
  | { ok: true; scan: FormScanResult; focused: boolean }
  | { ok: true; candidates: FormCandidateSummary[] }
  | { ok: true; report: FillReport }
  | { ok: true }
  | { ok: false; error: string };
