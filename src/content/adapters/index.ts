import type { FormControlElement } from '../scanner/field-filter';
import { AriaToggleAdapter } from './aria-toggle-adapter';
import { CheckboxAdapter } from './checkbox-adapter';
import { CustomSelectAdapter } from './custom-select-adapter';
import { DatePickerAdapter } from './date-picker-adapter';
import type { FieldAdapter } from './field-adapter';
import { InputAdapter } from './input-adapter';
import { RadioAdapter } from './radio-adapter';
import { NativeSelectAdapter } from './select-adapter';
import { SwitchAdapter } from './switch-adapter';
import { TextareaAdapter } from './textarea-adapter';

const adapters: FieldAdapter[] = [
  // 日期控件要排在下拉之前：antd 日期面板里没有可点的 option，走下拉流程必然失败。
  new DatePickerAdapter(),
  new CustomSelectAdapter(),
  new SwitchAdapter(),
  new AriaToggleAdapter(),
  new CheckboxAdapter(),
  new RadioAdapter(),
  new NativeSelectAdapter(),
  new TextareaAdapter(),
  new InputAdapter(),
];

export const getFieldAdapter = (element: FormControlElement): FieldAdapter | undefined =>
  adapters.find((adapter) => adapter.supports(element));
