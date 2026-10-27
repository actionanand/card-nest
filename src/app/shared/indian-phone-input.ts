import { Directive, ElementRef, forwardRef, inject } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

/** National digits only; legacy persisted +91 forms are expanded on write, never on keystroke. */
@Directive({
  selector: 'input[appIndianPhone]',
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => IndianPhoneInput), multi: true },
  ],
  host: {
    inputmode: 'numeric',
    autocomplete: 'tel-national',
    maxlength: '10',
    '(beforeinput)': 'before($event)',
    '(input)': 'read()',
    '(paste)': 'paste($event)',
    '(compositionstart)': 'composing = true',
    '(compositionend)': 'finish()',
    '(blur)': 'touched()',
  },
})
export class IndianPhoneInput implements ControlValueAccessor {
  private readonly element = inject<ElementRef<HTMLInputElement>>(ElementRef);
  composing = false;
  private changed: (value: string) => void = () => undefined;
  touched: () => void = () => undefined;
  writeValue(value: string | null): void {
    const text = value ?? '';
    const digits = text.replace(/^\+91[\s.-]*/, '').replace(/[\s.-]/g, '');
    this.element.nativeElement.value = /^\d{10}$/.test(digits) ? digits : text;
  }
  registerOnChange(fn: (value: string) => void): void {
    this.changed = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.touched = fn;
  }
  setDisabledState(disabled: boolean): void {
    this.element.nativeElement.disabled = disabled;
  }
  before(event: InputEvent): void {
    if (event.isComposing || !event.inputType.startsWith('insert') || event.data === null) return;
    const input = this.element.nativeElement;
    const length = input.value.length - ((input.selectionEnd ?? 0) - (input.selectionStart ?? 0));
    if (/\D/.test(event.data) || length + event.data.length > 10) event.preventDefault();
  }
  paste(event: ClipboardEvent): void {
    event.preventDefault();
    const input = this.element.nativeElement;
    const text = event.clipboardData?.getData('text') ?? '';
    const digits = text.replace(/^\+91[\s.-]*/, '').replace(/\D/g, '');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const inserted = digits.slice(0, Math.max(0, 10 - input.value.length + end - start));
    input.setRangeText(inserted, start, end, 'end');
    this.read();
  }
  finish(): void {
    this.composing = false;
    this.read();
  }
  read(): void {
    if (this.composing) return;
    const input = this.element.nativeElement;
    const national = input.value.replace(/^\+91[\s.-]*/, '');
    const caret = input.value
      .slice(0, input.selectionStart ?? input.value.length)
      .replace(/^\+91[\s.-]*/, '')
      .replace(/\D/g, '').length;
    input.value = national.replace(/\D/g, '').slice(0, 10);
    input.setSelectionRange(Math.min(caret, 10), Math.min(caret, 10));
    this.changed(input.value);
  }
}
