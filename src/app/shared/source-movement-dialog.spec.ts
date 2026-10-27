import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { readFileSync } from 'node:fs';
import { SourceMovementDialog } from './source-movement-dialog';
import { CardNestStore } from '../core/services/card-nest-store';
import { PaymentSource, SourceTransfer } from '../core/models/domain';
import { indiaTodayIso } from '../core/services/india-date';

describe('Movement timing selection', () => {
  const today = indiaTodayIso();
  const sources = signal<readonly PaymentSource[]>([
    {
      id: 'bank',
      kind: 'DEBIT',
      nickname: 'Bank',
      noLimit: true,
      autoLoad: false,
      archived: false,
      balanceMinor: 10000,
      balanceCutoverAt: `${today}T10:00:00+05:30`,
    },
    {
      id: 'cash',
      kind: 'CASH',
      nickname: 'Cash',
      noLimit: true,
      autoLoad: false,
      archived: false,
      balanceMinor: 2000,
      balanceCutoverAt: `${today}T10:00:00+05:30`,
    },
  ]);
  const saved: SourceTransfer = {
    id: 'saved',
    kind: 'CASH_WITHDRAWAL',
    fromSourceId: 'bank',
    toSourceId: 'cash',
    amountMinor: 1000,
    currencyCode: 'INR',
    transferDate: today,
    origin: 'MANUAL',
    balanceTiming: 'INCLUDED_IN_BASELINE',
    balanceTimingAt: `${today}T12:00:00+05:30`,
    createdAt: `${today}T12:00:00+05:30`,
    updatedAt: `${today}T12:00:00+05:30`,
  };
  const saveTransfer = vi.fn().mockResolvedValue(saved);
  beforeEach(() => {
    saveTransfer.mockReset().mockResolvedValue(saved);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: CardNestStore,
          useValue: {
            paymentSources: sources,
            activePaymentSources: sources,
            bankCashTracking: signal({ enabled: true }),
            categories: signal([]),
            sourceDetail: (id: string) => id,
            saveTransfer,
          },
        },
      ],
    });
  });
  const create = (editing = false) => {
    const fixture = TestBed.createComponent(SourceMovementDialog);
    fixture.componentRef.setInput('mode', 'TRANSFER');
    fixture.componentRef.setInput('presetFrom', 'bank');
    fixture.componentRef.setInput('presetTo', 'cash');
    if (editing) fixture.componentRef.setInput('transfer', saved);
    fixture.detectChanges();
    return fixture;
  };
  it('preselects the compact first radio and requires deliberate review before posting', async () => {
    const fixture = create();
    const page = fixture.componentInstance;
    page.amount.set('10');
    fixture.detectChanges();
    const radios = fixture.nativeElement.querySelectorAll(
      'input[type="radio"]',
    ) as NodeListOf<HTMLInputElement>;
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
    await page.submit(new Event('submit'));
    expect(saveTransfer).not.toHaveBeenCalled();
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event('change', { bubbles: true }));
    fixture.detectChanges();
    expect(page.timing()).toBe('INCLUDED_IN_BASELINE');
    page.timingReviewed.set(true);
    await page.submit(new Event('submit'));
    expect(saveTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ balanceTiming: 'INCLUDED_IN_BASELINE' }),
      'CREATE',
    );
    const styles = readFileSync('src/app/shared/source-movement-dialog.ts', 'utf8');
    expect(styles).toContain(".timing-choice input[type='radio']");
    expect(styles).toMatch(
      /width:\s*1.1rem;[\s\S]*?min-height:\s*1.1rem;[\s\S]*?flex:\s*0 0 1.1rem/,
    );
    fixture.destroy();
  });
  it('preserves a saved timing answer and resets review when date/source changes', () => {
    const fixture = create(true);
    const page = fixture.componentInstance;
    expect(page.timing()).toBe('INCLUDED_IN_BASELINE');
    page.amount.set('20');
    fixture.detectChanges();
    expect(page.timing()).toBe('INCLUDED_IN_BASELINE');
    page.timingReviewed.set(true);
    page.date.set('2026-10-20');
    fixture.detectChanges();
    expect(page.timingReviewed()).toBe(false);
    expect(page.timing()).toBe('INCLUDED_IN_BASELINE');
    fixture.destroy();
  });
});
