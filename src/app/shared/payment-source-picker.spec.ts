import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { PaymentSource } from '../core/models/domain';
import { CardNestStore } from '../core/services/card-nest-store';
import { PaymentSourcePicker } from './payment-source-picker';

describe('Quick Transaction payment source picker', () => {
  const sources = signal<readonly PaymentSource[]>([]);
  const store = {
    activeCards: computed(() => []),
    alphabeticalActiveCards: computed(() => []),
    activePaymentSources: computed(() => sources()),
  };

  beforeEach(() => {
    sources.set([
      {
        id: 'checking',
        kind: 'DEBIT',
        institution: 'ICICI Bank',
        nickname: 'Everyday checking',
        lastDigits: '45123',
        noLimit: true,
        autoLoad: false,
        archived: false,
      },
      {
        id: 'reserve',
        kind: 'DEBIT',
        institution: 'HDFC Bank',
        nickname: 'Reserve',
        lastDigits: '00007',
        noLimit: true,
        autoLoad: false,
        archived: false,
      },
    ]);
    TestBed.configureTestingModule({
      imports: [PaymentSourcePicker],
      providers: [{ provide: CardNestStore, useValue: store }],
    });
  });

  it('searches bank, nickname and suffix while preserving the explicit source ID', async () => {
    const fixture = TestBed.createComponent(PaymentSourcePicker);
    const picker = fixture.componentInstance;
    const selected = vi.fn();
    picker.valueChange.subscribe(selected);
    fixture.componentRef.setInput('value', 'reserve');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(picker.selectedLabel()).toBe('HDFC Bank · Reserve · •••007');

    picker.open.set(true);
    fixture.detectChanges();
    const search = fixture.nativeElement.querySelector('.picker-search input') as HTMLInputElement;
    search.value = 'HDFC Reserve 007';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    const options = fixture.nativeElement.querySelectorAll(
      '.picker-option',
    ) as NodeListOf<HTMLButtonElement>;
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('HDFC Bank');
    expect(options[0].textContent).toContain('Reserve');
    expect(options[0].textContent).toContain('•••007');

    options[0].click();
    expect(selected).toHaveBeenCalledWith('reserve');
    expect(picker.open()).toBe(false);
    fixture.destroy();
  });
});
