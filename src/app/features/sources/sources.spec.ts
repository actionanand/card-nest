import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SourcesPage } from './sources';
import { CardNestStore } from '../../core/services/card-nest-store';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { SnackbarService } from '../../core/services/snackbar.service';
import { CardTransaction, PaymentSource } from '../../core/models/domain';
import { TransactionsPage } from '../transactions/transactions';
import axe from 'axe-core';

describe('Explicit FASTag wallet creation and feedback', () => {
  const setup = () => {
    TestBed.configureTestingModule({
      imports: [SourcesPage],
      providers: [provideRouter([]), { provide: SqliteDatabase, useValue: { ready: () => false } }],
    });
    const fixture = TestBed.createComponent(SourcesPage);
    fixture.detectChanges();
    fixture.componentInstance.walletOpen.set(true);
    fixture.componentInstance.walletForm.setValue({
      name: 'Synthetic vehicle',
      provider: 'Fictional toll provider',
      plate: 'FICT001',
    });
    return fixture;
  };
  it('opens FASTag creation in a dialog and restores focus after Cancel', async () => {
    const fixture = setup();
    const page = fixture.componentInstance;
    page.walletOpen.set(false);
    fixture.detectChanges();
    const trigger = fixture.nativeElement.querySelector('.fastag-trigger') as HTMLButtonElement;
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-profile-modal dialog[open]')).not.toBeNull();
    const cancel = [...fixture.nativeElement.querySelectorAll('app-profile-modal button')].find(
      (button: HTMLButtonElement) => button.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    cancel.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.walletOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);
    fixture.destroy();
  });
  it('shows success after saving, resets/collapses the form and preserves existing wallets and balances', async () => {
    const fixture = setup();
    const store = TestBed.inject(CardNestStore);
    const before = store.paymentSources();
    const add = vi.spyOn(store, 'addWallet').mockResolvedValue();
    const snackbar = vi.spyOn(TestBed.inject(SnackbarService), 'show');
    await fixture.componentInstance.addFastag(new Event('submit'));
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: 'Synthetic vehicle',
        kind: 'FASTAG',
        vehicleNumber: 'FICT001',
        balanceMinor: 0,
      }),
    );
    expect(snackbar).toHaveBeenCalledWith('FASTag wallet created.');
    expect(fixture.componentInstance.walletOpen()).toBe(false);
    expect(fixture.componentInstance.walletForm.pristine).toBe(true);
    expect(fixture.componentInstance.walletForm.controls.name.value).toBe('');
    expect(store.paymentSources()).toEqual(before);
  });
  it('keeps invalid registration or failed creation editable and reports the failure without success', async () => {
    const fixture = setup();
    const store = TestBed.inject(CardNestStore);
    const add = vi
      .spyOn(store, 'addWallet')
      .mockRejectedValue(new Error('Synthetic wallet write failure'));
    const snackbar = vi.spyOn(TestBed.inject(SnackbarService), 'show');
    fixture.componentInstance.walletForm.controls.plate.setValue('!');
    await fixture.componentInstance.addFastag(new Event('submit'));
    expect(add).not.toHaveBeenCalled();
    fixture.componentInstance.walletForm.controls.plate.setValue('FICT001');
    await fixture.componentInstance.addFastag(new Event('submit'));
    expect(fixture.componentInstance.walletOpen()).toBe(true);
    expect(fixture.componentInstance.walletForm.controls.name.value).toBe('Synthetic vehicle');
    expect(snackbar).toHaveBeenCalledExactlyOnceWith('Synthetic wallet write failure', 'WARNING');
  });
  it('prevents repeated submit while creation is pending', async () => {
    const fixture = setup();
    let finish!: () => void;
    const add = vi
      .spyOn(TestBed.inject(CardNestStore), 'addWallet')
      .mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const first = fixture.componentInstance.addFastag(new Event('submit'));
    await fixture.componentInstance.addFastag(new Event('submit'));
    expect(add).toHaveBeenCalledOnce();
    expect(fixture.componentInstance.walletSaving()).toBe(true);
    finish();
    await first;
    expect(fixture.componentInstance.walletSaving()).toBe(false);
  });
  it('routes bank enrollment and identity editing to Discovered Accounts', () => {
    const fixture = setup();
    const section = fixture.nativeElement.querySelector(
      '.bank-accounts-section',
    ) as HTMLDetailsElement;
    section.open = true;
    fixture.detectChanges();
    const manage = section.querySelector('a') as HTMLAnchorElement | null;
    expect(manage?.textContent).toContain('Manage bank accounts');
    expect(manage?.getAttribute('href')).toContain('/bank-activity');
    expect(fixture.nativeElement.textContent).not.toContain('Account breakdown (read only)');
    expect(fixture.nativeElement.textContent).not.toContain('Enrol a bank account');
    expect(fixture.nativeElement.querySelector('form[formgroup="bankForm"]')).toBeNull();
    fixture.destroy();
  });
  it('shows a known bank subtotal without treating untracked accounts as zero', () => {
    const fixture = setup();
    const store = TestBed.inject(CardNestStore);
    store.paymentSources.set([
      {
        id: 'known-bank',
        kind: 'DEBIT',
        nickname: 'Everyday',
        institution: 'ICICI Bank',
        lastDigits: '45123',
        balanceMinor: 100000,
        balanceCutoverAt: '2026-10-28T10:00:00Z',
        noLimit: true,
        autoLoad: false,
        archived: false,
      },
      {
        id: 'unknown-bank',
        kind: 'DEBIT',
        nickname: 'Reserve',
        institution: 'HDFC Bank',
        lastDigits: '00007',
        noLimit: true,
        autoLoad: false,
        archived: false,
      },
    ]);
    store.bankCashTracking.set({ enabled: true, askCardSettlementFunding: false });
    fixture.detectChanges();
    expect(fixture.componentInstance.bankBalanceSummary().status).toBe('INCOMPLETE');
    expect(fixture.componentInstance.remainingLabel()).toContain('Incomplete');
    const details = fixture.nativeElement.querySelector(
      '.bank-accounts-section',
    ) as HTMLDetailsElement;
    details.open = true;
    fixture.detectChanges();
    expect(details.textContent).toContain('Known subtotal · ₹1,000.00');
    expect(details.textContent).toContain('₹1,000.00');
    expect(details.textContent).toContain('Balance not set');
    expect(fixture.nativeElement.textContent).not.toContain('Account breakdown (read only)');

    store.paymentSources.update((sources) =>
      sources.map((source) =>
        source.id === 'unknown-bank'
          ? { ...source, balanceMinor: 250000, balanceCutoverAt: '2026-10-28T10:00:00Z' }
          : source,
      ),
    );
    fixture.detectChanges();
    expect(fixture.componentInstance.bankBalanceSummary()).toMatchObject({
      status: 'KNOWN',
      totalMinor: 350000,
    });
    expect(fixture.componentInstance.remainingLabel()).toContain('₹3,500.00');
    expect(details.textContent).toContain('Total · ₹3,500.00');
    fixture.destroy();
  });
  it('orders wallet activity by event time and shows recorded time without using scan time', async () => {
    const fixture = setup();
    const store = TestBed.inject(CardNestStore);
    store.paymentSources.set([
      {
        id: 'synthetic-meal',
        kind: 'MEAL',
        nickname: 'Synthetic Pluxee',
        noLimit: false,
        autoLoad: false,
        archived: false,
        balanceMinor: 93724,
      },
    ]);
    const entry: CardTransaction = {
      id: 'meal-early',
      cardId: 'synthetic-meal',
      type: 'PURCHASE',
      amountMinor: 10000,
      currencyCode: 'INR',
      transactionDate: '2026-10-23',
      transactionTime: '05:17:27',
      categoryId: 'dining',
      merchant: 'Fictional meal',
      attachmentIds: [],
      createdAt: '2026-10-24T23:59:00Z',
      updatedAt: '2026-10-24T23:59:00Z',
    };
    store.transactions.set([
      entry,
      {
        ...entry,
        id: 'meal-later',
        transactionTime: '06:00:00',
        createdAt: '2026-10-23T01:00:00Z',
      },
    ]);
    fixture.componentInstance.showSourceActivity('synthetic-meal');
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleTransactions().map((item) => item.id)).toEqual([
      'meal-later',
      'meal-early',
    ]);
    expect(fixture.nativeElement.querySelectorAll('.transaction-time')).toHaveLength(2);
    expect(fixture.componentInstance.recordedTime({ ...entry, transactionTime: undefined })).toBe(
      '',
    );
    const activity = TestBed.createComponent(TransactionsPage);
    store.showTransactionTime.set(false);
    expect(activity.componentInstance.recordedTime(entry)).toBe('');
    expect(activity.componentInstance.recordedEventTime(entry)).not.toBe('');
    activity.componentInstance.openDetails(entry);
    activity.detectChanges();
    expect(activity.nativeElement.querySelector('.transaction-detail')?.textContent).toContain(
      activity.componentInstance.recordedEventTime(entry),
    );
    activity.detectChanges();
    const filterTrigger = activity.nativeElement.querySelector(
      '.filter-panel__toggle',
    ) as HTMLButtonElement;
    filterTrigger.click();
    activity.detectChanges();
    await activity.whenStable();
    const filterDialog = activity.nativeElement.querySelector(
      'app-profile-modal dialog[open]',
    ) as HTMLElement;
    expect(filterDialog).not.toBeNull();
    const audit = await axe.run(filterDialog, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(audit.violations).toEqual([]);
    expect(
      activity.componentInstance.sourceFilterOptions().map((option) => option.value),
    ).toContain('synthetic-meal');
    activity.componentInstance.selectSourceFilter('synthetic-meal');
    expect(activity.componentInstance.filtered().map((transaction) => transaction.cardId)).toEqual([
      'synthetic-meal',
      'synthetic-meal',
    ]);
    activity.destroy();
  });
  it('audits Pluxee cycle totals from local-date committed entries for that source only', () => {
    const nativeOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    const timezone = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...nativeOptions.call(this), timeZone: 'Asia/Kolkata' };
      });
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-31T20:30:00Z'));
    const fixture = setup();
    try {
      const store = TestBed.inject(CardNestStore);
      const first: PaymentSource = {
        id: 'meal-first',
        kind: 'MEAL',
        nickname: 'Synthetic Pluxee A',
        noLimit: false,
        autoLoad: false,
        archived: false,
      };
      const second: PaymentSource = { ...first, id: 'meal-second', nickname: 'Synthetic Pluxee B' };
      const cash: PaymentSource = {
        id: 'cash-date-test',
        kind: 'CASH',
        nickname: 'Synthetic cash',
        noLimit: true,
        autoLoad: false,
        archived: false,
      };
      store.paymentSources.set([first, second, cash]);
      const entry = (
        id: string,
        cardId: string,
        type: CardTransaction['type'],
        amountMinor: number,
        transactionDate: string,
      ): CardTransaction => ({
        id,
        cardId,
        type,
        amountMinor,
        currencyCode: 'INR',
        transactionDate,
        categoryId: 'other',
        attachmentIds: [],
        createdAt: `${transactionDate}T12:00:00Z`,
        updatedAt: `${transactionDate}T12:00:00Z`,
      });
      store.transactions.set([
        entry('meal-a-spend', first.id, 'PURCHASE', 1200, '2026-11-02'),
        entry('meal-a-topup', first.id, 'CREDIT', 5000, '2026-11-03'),
        entry('meal-a-previous', first.id, 'PURCHASE', 3000, '2026-10-31'),
        entry('meal-b-spend', second.id, 'PURCHASE', 9000, '2026-11-02'),
        entry('meal-b-topup', second.id, 'CREDIT', 12000, '2026-11-03'),
      ]);
      store.balanceAdjustments.set([
        {
          id: 'meal-a-audit',
          sourceId: first.id,
          reason: 'CORRECTION',
          previousMinor: 10000,
          newMinor: 60000,
          correctionMinor: 50000,
          createdAt: '2026-11-03T12:00:00Z',
        },
      ]);
      fixture.detectChanges();

      const page = fixture.componentInstance;
      expect(page.currentCycle().startIso).toBe('2026-11-01');
      expect(page.monthlyUsed(first)).toBe(1200);
      expect(page.monthlyRemaining(first)).toBe(3800);
      expect(page.monthlyUsed(second)).toBe(9000);
      expect(page.monthlyRemaining(second)).toBe(3000);

      const transactions = TestBed.createComponent(TransactionsPage);
      transactions.detectChanges();
      expect(transactions.componentInstance.form.controls.transactionDate.value).toBe('2026-11-01');
      transactions.destroy();

      page.openMovement({ mode: 'RECEIPT', sourceId: cash.id });
      fixture.detectChanges();
      expect(
        (
          fixture.nativeElement.querySelector(
            'app-source-movement-dialog input[type="date"]',
          ) as HTMLInputElement
        ).value,
      ).toBe('2026-11-01');
    } finally {
      fixture.destroy();
      timezone.mockRestore();
      vi.useRealTimers();
    }
  });
});
