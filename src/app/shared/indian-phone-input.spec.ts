import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { IndianPhoneInput } from './indian-phone-input';
import { normalizeIndianMobileNumber } from '../features/utilities/utilities.service';

@Component({
  imports: [IndianPhoneInput, ReactiveFormsModule],
  template: '<label>Number<span>+91-</span><input appIndianPhone [formControl]="number" /></label>',
})
class Host {
  readonly number = new FormControl('', { nonNullable: true });
}

describe('Indian national phone input', () => {
  it('lets an oversized malformed legacy value be corrected without dropping unselected digits', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.number.setValue('9876543210123');
    fixture.detectChanges();
    const input = (fixture.nativeElement as HTMLElement).querySelector('input')!;
    expect(input.value).toBe('9876543210123');
    input.value = '987654321012';
    input.setSelectionRange(12, 12);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fixture.componentInstance.number.value).toBe('987654321012');
    expect(input.value).toBe('987654321012');
    input.value = '9876543210';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fixture.componentInstance.number.value).toBe('9876543210');
    fixture.destroy();
  });
  it.each(['9876543210', '+919876543210', '+91 9876543210', '+91-9876543210'])(
    'loads %s with one prefix and normalized persistence',
    (value) => {
      const fixture = TestBed.createComponent(Host);
      fixture.componentInstance.number.setValue(value);
      fixture.detectChanges();
      const input = (fixture.nativeElement as HTMLElement).querySelector('input')!;
      expect(input.value).toBe('9876543210');
      expect(input.maxLength).toBe(10);
      expect(normalizeIndianMobileNumber(fixture.componentInstance.number.value)).toBe(
        '+91-9876543210',
      );
      fixture.destroy();
    },
  );
  it('blocks an eleventh digit and non-digits before editing, while allowing selection replacement', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.number.setValue('9876543210');
    fixture.detectChanges();
    const input = (fixture.nativeElement as HTMLElement).querySelector('input')!;
    input.setSelectionRange(10, 10);
    for (const data of ['1', 'A', ' ', '-']) {
      const event = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    input.setSelectionRange(2, 4);
    const event = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: '55',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    fixture.destroy();
  });
  it('sanitizes autofill and IME at commit, preserves optional empty and rejects partial or invalid numbers', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const input = (fixture.nativeElement as HTMLElement).querySelector('input')!;
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = '9a876543210111';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fixture.componentInstance.number.value).toBe('');
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(input.value).toBe('9876543210');
    expect(fixture.componentInstance.number.value).toBe('9876543210');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(normalizeIndianMobileNumber(fixture.componentInstance.number.value)).toBeUndefined();
    expect(() => normalizeIndianMobileNumber('98765')).toThrow();
    expect(() => normalizeIndianMobileNumber('1234567890')).toThrow();
    fixture.destroy();
  });
  it('handles long pasted digits and a pasted country prefix without duplicating it', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const input = (fixture.nativeElement as HTMLElement).querySelector('input')!;
    const paste = (text: string) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
      input.dispatchEvent(event);
    };
    paste('+91 98765432109999');
    expect(input.value).toBe('9876543210');
    input.setSelectionRange(0, 10);
    paste('8765432109');
    expect(input.value).toBe('8765432109');
    expect(fixture.componentInstance.number.value).toBe('8765432109');
    fixture.destroy();
  });
});
