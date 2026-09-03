import type {
  FieldAssignment,
  FillReport,
  FormScanResult,
} from '../../modules/form-clipboard/clipboard-types';

export type ContentRequest =
  | { type: 'SCAN_FORM' }
  | { type: 'APPLY_FIELDS'; assignments: FieldAssignment[] }
  | { type: 'SHOW_TOAST'; message: string; tone?: 'success' | 'error' };

export type ContentResponse =
  | { ok: true; scan: FormScanResult }
  | { ok: true; report: FillReport }
  | { ok: true }
  | { ok: false; error: string };
