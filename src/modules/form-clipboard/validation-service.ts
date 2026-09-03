import type { FormValue } from './clipboard-types';

export interface UniqueFieldValue {
  key: string;
  label: string;
  originalValue: FormValue;
  nextValue: FormValue;
}

const comparable = (value: FormValue): string => JSON.stringify(value);

export const validateUniqueFields = (
  fields: UniqueFieldValue[],
): { valid: boolean; errors: string[] } => {
  const errors = fields.flatMap((field) => {
    const empty = field.nextValue === null || field.nextValue === '';
    if (empty || comparable(field.originalValue) === comparable(field.nextValue)) {
      return [`${field.label} 与原配置相同，请修改。`];
    }
    return [];
  });

  return { valid: errors.length === 0, errors };
};
