import type {
  FieldAssignment,
  FillReport,
  FormScanResult,
  FormTargetSnapshot,
} from '../../modules/form-clipboard/clipboard-types';

export type ContentRequest =
  | { type: 'SCAN_FORM' }
  | { type: 'APPLY_FIELDS'; assignments: FieldAssignment[]; expectedTarget?: FormTargetSnapshot }
  | { type: 'SHOW_TOAST'; message: string; tone?: 'success' | 'error' };

export type ContentResponse =
  | { ok: true; scan: FormScanResult; focused: boolean }
  | { ok: true; report: FillReport }
  | { ok: true }
  | { ok: false; error: string };
