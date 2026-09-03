import type { FormControlElement } from '../scanner/field-filter';
import { CheckboxAdapter } from './checkbox-adapter';
import { CustomSelectAdapter } from './custom-select-adapter';
import type { FieldAdapter } from './field-adapter';
import { InputAdapter } from './input-adapter';
import { RadioAdapter } from './radio-adapter';
import { NativeSelectAdapter } from './select-adapter';
import { TextareaAdapter } from './textarea-adapter';

const adapters: FieldAdapter[] = [
  new CustomSelectAdapter(),
  new CheckboxAdapter(),
  new RadioAdapter(),
  new NativeSelectAdapter(),
  new TextareaAdapter(),
  new InputAdapter(),
];

export const getFieldAdapter = (element: FormControlElement): FieldAdapter | undefined =>
  adapters.find((adapter) => adapter.supports(element));
