import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { AppSelectPicker } from './app-select-picker';

@Component({
  imports: [AppSelectPicker, ReactiveFormsModule],
  template: `<app-select-picker
    label="Synthetic choice"
    [formControl]="control"
    [options]="options"
    [searchable]="true"
  />`,
})
class FormHost {
  readonly control = new FormControl('a', { nonNullable: true, validators: Validators.required });
  readonly options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta', disabled: true },
    { value: 'c', label: 'Gamma', detail: 'Synthetic detail' },
  ];
}
describe('Shared picker reactive forms and native modal integration', () => {
  const setup = () => {
    TestBed.configureTestingModule({ imports: [FormHost] });
    const fixture = TestBed.createComponent(FormHost);
    fixture.detectChanges();
    const picker = fixture.debugElement.query(By.directive(AppSelectPicker))
      .componentInstance as AppSelectPicker;
    return { fixture, picker, control: fixture.componentInstance.control };
  };
  it('implements writeValue and selection with correct dirty, touched and validation state', () => {
    const { fixture, picker, control } = setup();
    expect(picker.currentValue()).toBe('a');
    expect(control.pristine).toBe(true);
    control.setValue('c');
    fixture.detectChanges();
    expect(picker.selectedLabel()).toBe('Gamma');
    expect(control.pristine).toBe(true);
    picker.select('a');
    fixture.detectChanges();
    expect(control.value).toBe('a');
    expect(control.dirty).toBe(true);
    expect(control.touched).toBe(true);
    expect(control.valid).toBe(true);
    control.reset('');
    fixture.detectChanges();
    expect(control.invalid).toBe(true);
    expect(picker.currentValue()).toBe('');
  });
  it('honors form disabled state and disabled options without changing the selected value', () => {
    const { fixture, picker, control } = setup();
    picker.select('b');
    expect(control.value).toBe('a');
    control.disable();
    fixture.detectChanges();
    expect(
      (fixture.nativeElement.querySelector('.picker-trigger') as HTMLButtonElement).disabled,
    ).toBe(true);
    picker.show();
    expect(picker.open()).toBe(false);
    picker.select('c');
    expect(control.value).toBe('a');
    control.enable();
    fixture.detectChanges();
    picker.select('c');
    expect(control.value).toBe('c');
  });
  it('uses a native top-layer dialog, filters long lists and closes on Android Back without choosing anything', async () => {
    const { fixture, picker, control } = setup();
    const element = fixture.nativeElement as HTMLElement;
    document.body.append(element);
    picker.show();
    fixture.detectChanges();
    expect(element.querySelector('dialog')?.open).toBe(true);
    expect(document.documentElement.style.overflow).toBe('hidden');
    picker.searchQuery.set('synthetic detail');
    fixture.detectChanges();
    expect(picker.filteredOptions().map((option) => option.value)).toEqual(['c']);
    const event = new Event('cardnest:back', { cancelable: true });
    window.dispatchEvent(event);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(event.defaultPrevented).toBe(true);
    expect(picker.open()).toBe(false);
    expect(control.value).toBe('a');
    expect(control.pristine).toBe(true);
    expect(control.touched).toBe(true);
    expect(document.activeElement).toBe(element.querySelector('.picker-trigger'));
    element.remove();
  });
  it('native cancel restores focus and option arrow navigation skips disabled entries', async () => {
    const { fixture, picker, control } = setup();
    const element = fixture.nativeElement as HTMLElement;
    document.body.append(element);
    picker.show();
    fixture.detectChanges();
    const options = [...element.querySelectorAll<HTMLButtonElement>('.picker-option')];
    options[0].focus();
    picker.navigateOptions(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    expect(document.activeElement).toBe(options[2]);
    const event = new Event('cancel', { cancelable: true });
    element.querySelector('dialog')!.dispatchEvent(event);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(event.defaultPrevented).toBe(true);
    expect(control.value).toBe('a');
    expect(document.activeElement).toBe(element.querySelector('.picker-trigger'));
    element.remove();
  });
});
