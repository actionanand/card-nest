import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { readFileSync } from 'node:fs';
import { SourceMovementDialog } from './source-movement-dialog';
import { CardNestStore } from '../core/services/card-nest-store';
import { PaymentSource, SourceTransfer } from '../core/models/domain';
import { currentLocalCalendar, DeviceCalendarClock } from '../core/services/device-date';

describe('Movement timing selection', () => {
  const today = '2026-11-01';
  const calendar = signal({
    timeZone: 'UTC',
    dateIso: today,
    monthIso: '2026-11',
    timeOfDay: '20:00:00',
  });
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
  const addSourceBalance = vi.fn().mockResolvedValue(undefined);
  const setSourceBalance = vi.fn().mockResolvedValue(undefined);
  const setCalendar = (dateIso: string, timeZone: string, timeOfDay = '12:00:00') => {
    calendar.set({ dateIso, timeZone, monthIso: dateIso.slice(0, 7), timeOfDay });
    sources.update((items) =>
      items.map((source) => ({
        ...source,
        balanceCutoverAt: `${dateIso}T10:00:00+05:30`,
      })),
    );
  };
  beforeEach(() => {
    setCalendar(today, 'UTC', '20:00:00');
    saveTransfer.mockReset().mockResolvedValue(saved);
    addSourceBalance.mockReset().mockResolvedValue(undefined);
    setSourceBalance.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: DeviceCalendarClock, useValue: { calendar } },
        {
          provide: CardNestStore,
          useValue: {
            paymentSources: sources,
            activePaymentSources: sources,
            bankCashTracking: signal({ enabled: true }),
            categories: signal([]),
            sourceDetail: (id: string) => id,
            saveTransfer,
            addSourceBalance,
            setSourceBalance,
          },
        },
      ],
    });
  });
  afterEach(() => vi.restoreAllMocks());
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
  it.each([
    ['UTC', '2026-11-01'],
    ['Asia/Kolkata', '2026-11-02'],
  ])('renders both timing choices in %s at the UTC/IST date boundary', (timeZone, dateIso) => {
    const nativeOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...nativeOptions.call(this), timeZone } as Intl.ResolvedDateTimeFormatOptions;
    });
    const localCalendar = currentLocalCalendar(new Date('2026-11-01T20:00:00Z'));
    expect(localCalendar.dateIso).toBe(dateIso);
    setCalendar(localCalendar.dateIso, localCalendar.timeZone, localCalendar.timeOfDay);

    const fixture = create();
    const page = fixture.componentInstance;
    expect(page.date()).toBe(dateIso);
    expect(page.timingNeeded()).toBe(true);
    expect(
      fixture.nativeElement.querySelectorAll('.timing-choice input[type="radio"]'),
    ).toHaveLength(2);
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

  it('previews additive balance changes and saves an adjustment instead of a receipt', async () => {
    const fixture = TestBed.createComponent(SourceMovementDialog);
    fixture.componentRef.setInput('mode', 'ADD_MONEY');
    fixture.componentRef.setInput('sourceId', 'cash');
    fixture.detectChanges();
    const page = fixture.componentInstance;
    page.amount.set('10');
    fixture.detectChanges();
    expect(page.balancePreview()).toContain('20');
    expect(page.balancePreview()).toContain('30');
    expect(page.balancePreview()).toContain('not income or spending');

    await page.submit(new Event('submit'));
    expect(addSourceBalance).toHaveBeenCalledWith('cash', 1000, '');
    expect(saveTransfer).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it('replaces Cash with the checked amount including zero without calling additive posting', async () => {
    const fixture = TestBed.createComponent(SourceMovementDialog);
    fixture.componentRef.setInput('mode', 'ADD_MONEY');
    fixture.componentRef.setInput('sourceId', 'cash');
    fixture.detectChanges();
    const page = fixture.componentInstance;
    expect(page.replaceCashBalance()).toBe(false);
    const checkbox = fixture.nativeElement.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    checkbox.click();
    page.amount.set('0');
    fixture.detectChanges();
    expect(page.balancePreview()).toContain('instead of adding');
    await page.submit(new Event('submit'));
    expect(setSourceBalance).toHaveBeenCalledWith('cash', 0, '');
    expect(addSourceBalance).not.toHaveBeenCalled();
    expect(saveTransfer).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it.each(['Escape', 'Back'])(
    'focuses the Cash amount and supports %s dismissal without posting',
    async (method) => {
      const fixture = TestBed.createComponent(SourceMovementDialog);
      fixture.componentRef.setInput('mode', 'ADD_MONEY');
      fixture.componentRef.setInput('sourceId', 'cash');
      const closed = vi.fn();
      fixture.componentInstance.closed.subscribe(closed);
      fixture.detectChanges();
      await fixture.whenStable();
      const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      if (method === 'Escape')
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      else window.dispatchEvent(new Event('cardnest:back', { cancelable: true }));
      expect(closed).toHaveBeenCalledOnce();
      expect(addSourceBalance).not.toHaveBeenCalled();
      expect(setSourceBalance).not.toHaveBeenCalled();
      fixture.destroy();
    },
  );
});
