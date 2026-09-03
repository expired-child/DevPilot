import type { FormField } from './clipboard-types';

const stableValue = (value: FormField['value']): string =>
  Array.isArray(value) ? JSON.stringify([...value].sort()) : JSON.stringify(value);

export const createFingerprint = (host: string, fields: FormField[]): string => {
  const content = fields
    .map((field) => `${field.key}\u0000${field.type}\u0000${stableValue(field.value)}`)
    .sort()
    .join('\u0001');
  const input = `${host}\u0002${content}`;
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
};
