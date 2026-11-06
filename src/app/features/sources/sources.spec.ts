import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { SourcesPage } from './sources';
import { CardNestStore } from '../../core/services/card-nest-store';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import {
  CardTransaction,
  ConsumerWallet,
  ConsumerWalletEvent,
  CreditCard,
  PaymentSource,
} from '../../core/models/domain';
import { ConsumerWalletService } from '../../core/services/consumer-wallet.service';
import { TransactionsPage } from '../transactions/transactions';
import axe from 'axe-core';

describe('FASTag source visibility and management relocation', () => {
  const setup = () => {
    TestBed.configureTestingModule({
      imports: [SourcesPage],
      providers: [provideRouter([]), { provide: SqliteDatabase, useValue: { ready: () => false } }],
    });
    const fixture = TestBed.createComponent(SourcesPage);
    fixture.detectChanges();
    return fixture;
  };
  it('keeps consumer wallet IDs separate and filters unified activity without ID collisions', () => {
    const sourceFixture = setup();
    const store = TestBed.inject(CardNestStore);
    const wallets = TestBed.inject(ConsumerWalletService);
    const card: CreditCard = {
      id: 'wallet-activity-card',
      nickname: 'Synthetic card',
      issuerName: 'Fictional bank',
      lastDigits: '1111',
      network: 'VISA',
      currencyCode: 'INR',
      theme: 'green',
      statementDay: 1,
      dueDateMode: 'DAYS_AFTER_STATEMENT',
      daysAfterStatement: 20,
      adjustDueDateOnWeekend: false,
      openingBalanceMinor: 0,
      remindToSettle: false,
      annualFeeEnabled: false,
      emergencyPhones: [],
      supportEmails: [],
      archived: false,
      createdAt: '2026-10-01',
      updatedAt: '2026-10-01',
    };
    const wallet: ConsumerWallet = {
      id: 'wallet-activity-wallet',
      providerId: 'amazon-pay',
      kind: 'STANDARD',
      nickname: 'Synthetic wallet',
      archived: false,
      createdAt: '2026-10-01',
      updatedAt: '2026-10-01',
    };
    const cardTransaction: CardTransaction = {
      id: 'shared-display-id',
      cardId: card.id,
      type: 'PURCHASE',
      amountMinor: 5000,
      currencyCode: 'INR',
      transactionDate: '2026-10-20',
      categoryId: 'other',
      merchant: 'Synthetic card merchant',
      attachmentIds: [],
      createdAt: '2026-10-20T10:00:00Z',
      updatedAt: '2026-10-20T10:00:00Z',
    };
    const walletPurchase: ConsumerWalletEvent = {
      id: 'shared-display-id',
      walletId: wallet.id,
      eventType: 'PURCHASE',
      eventDate: '2026-10-20',
      amountMinor: 4000,
      balanceDeltaMinor: -4000,
      categoryId: 'other',
      merchant: 'Synthetic wallet merchant',
      createdAt: '2026-10-20T11:00:00Z',
      updatedAt: '2026-10-20T11:00:00Z',
    };
    store.cards.set([card]);
    store.transactions.set([cardTransaction]);
    wallets.wallets.set([wallet]);
    wallets.events.set([walletPurchase]);
    wallets.featureState.set('ENABLED');

    const fixture = TestBed.createComponent(TransactionsPage);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    const walletSource = `consumer-wallet:${wallet.id}`;
    page.selectPayFrom(walletSource);
    expect(page.form.controls.consumerWalletId.value).toBe(wallet.id);
    expect(page.form.controls.cardId.value).toBe('');

    page.selectPayFrom(card.id);
    expect(page.form.controls.consumerWalletId.value).toBe('');
    expect(page.form.controls.cardId.value).toBe(card.id);

    expect(page.activityProjection().map((activity) => activity.key)).toEqual(
      expect.arrayContaining(['card:shared-display-id', 'wallet:shared-display-id']),
    );
    expect(
      page.activityProjection().find((activity) => activity.kind === 'CONSUMER_WALLET_EVENT'),
    ).toMatchObject({
      classification: 'SPENDING_ALREADY_COUNTED',
      consolidatedExpenseContributionMinor: 0,
    });
    page.selectSourceFilter(walletSource);
    expect(page.activityProjection().map((activity) => activity.key)).toEqual([
      'wallet:shared-display-id',
    ]);
    fixture.destroy();
    sourceFixture.destroy();
  });
  it('removes FASTag creation from Sources while preserving existing FASTag source visibility', () => {
    const fixture = setup();
    const store = TestBed.inject(CardNestStore);
    const fastag: PaymentSource = {
      id: 'preserved-fastag-source',
      kind: 'FASTAG',
      nickname: 'Synthetic vehicle',
      vehicleNumber: 'FICT001',
      noLimit: false,
      balanceMinor: 12000,
      autoLoad: false,
      archived: false,
    };
    store.paymentSources.set([...store.paymentSources(), fastag]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.fastag-trigger')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Add FASTAG wallet');
    expect(fixture.componentInstance.nonBankSources()).not.toContainEqual(fastag);
    expect(
      fixture.componentInstance.sourceOptions().some((option) => option.value === fastag.id),
    ).toBe(true);
    const toll: CardTransaction = {
      id: 'preserved-fastag-toll',
      cardId: fastag.id,
      type: 'PURCHASE',
      amountMinor: 1200,
      currencyCode: 'INR',
      transactionDate: '2026-10-25',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: '2026-10-25T10:00:00Z',
      updatedAt: '2026-10-25T10:00:00Z',
    };
    store.transactions.set([toll]);
    fixture.componentInstance.showSourceActivity(fastag.id);
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleTransactions()).toEqual([toll]);
    fixture.destroy();
  });
  it('navigates FASTag transactions to their wallet without changing other source routes', () => {
    const fixture = setup();
    const store = TestBed.inject(CardNestStore);
    const fastag: PaymentSource = {
      id: 'preserved-fastag-source',
      kind: 'FASTAG',
      nickname: 'Synthetic vehicle',
      vehicleNumber: 'FICT001',
      noLimit: false,
      balanceMinor: 12000,
      autoLoad: false,
      archived: true,
    };
    store.paymentSources.set([
      fastag,
      {
        id: 'synthetic-bank',
        kind: 'DEBIT',
        nickname: 'Synthetic bank',
        noLimit: true,
        autoLoad: false,
        archived: false,
      },
      {
        id: 'synthetic-meal',
        kind: 'MEAL',
        nickname: 'Synthetic Pluxee',
        noLimit: false,
        autoLoad: false,
        archived: false,
      },
    ]);
    const card = { id: 'synthetic-card' } as CreditCard;
    store.cards.set([card]);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const transactions = TestBed.createComponent(TransactionsPage);
    const transaction = (id: string, cardId: string): CardTransaction => ({
      id,
      cardId,
      type: 'PURCHASE',
      amountMinor: 1200,
      currencyCode: 'INR',
      transactionDate: '2026-10-25',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: '2026-10-25T10:00:00Z',
      updatedAt: '2026-10-25T10:00:00Z',
    });

    const toll = transaction('archived-fastag-toll-record', fastag.id);
    transactions.componentInstance.goToSource(toll);
    expect(navigate).toHaveBeenLastCalledWith(['/wallets'], {
      queryParams: { source: fastag.id, transaction: toll.id },
    });
    navigate.mockClear();
    transactions.componentInstance.goToSource(transaction('bank-transaction', 'synthetic-bank'));
    expect(navigate).toHaveBeenLastCalledWith(['/sources'], { fragment: 'synthetic-bank' });
    navigate.mockClear();
    transactions.componentInstance.goToSource(transaction('meal-transaction', 'synthetic-meal'));
    expect(navigate).toHaveBeenLastCalledWith(['/sources'], { fragment: 'synthetic-meal' });
    navigate.mockClear();
    transactions.componentInstance.goToSource(transaction('card-transaction', card.id));
    expect(navigate).toHaveBeenLastCalledWith(['/cards'], { queryParams: { open: card.id } });
    transactions.destroy();
    fixture.destroy();
  });
  it('routes FASTag transactions to their Wallets record and preserves other source routes', () => {
    const fixture = setup();
    const store = TestBed.inject(CardNestStore);
    const fastag: PaymentSource = {
      id: 'preserved-fastag-source',
      kind: 'FASTAG',
      nickname: 'Synthetic vehicle',
      vehicleNumber: 'FICT001',
      noLimit: false,
      balanceMinor: 12000,
      autoLoad: false,
      archived: true,
    };
    store.paymentSources.set([
      fastag,
      {
        id: 'synthetic-bank',
        kind: 'DEBIT',
        nickname: 'Synthetic bank',
        noLimit: true,
        autoLoad: false,
        archived: false,
      },
      {
        id: 'synthetic-meal',
        kind: 'MEAL',
        nickname: 'Synthetic Pluxee',
        noLimit: false,
        autoLoad: false,
        archived: false,
      },
    ]);
    const card = { id: 'synthetic-card' } as CreditCard;
    store.cards.set([card]);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const page = TestBed.createComponent(TransactionsPage).componentInstance;
    const transaction = (id: string, cardId: string): CardTransaction => ({
      id,
      cardId,
      type: 'PURCHASE',
      amountMinor: 1200,
      currencyCode: 'INR',
      transactionDate: '2026-10-25',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: '2026-10-25T10:00:00Z',
      updatedAt: '2026-10-25T10:00:00Z',
    });

    const toll = transaction('archived-fastag-toll-record', fastag.id);
    page.goToSource(toll);
    expect(navigate).toHaveBeenLastCalledWith(['/wallets'], {
      queryParams: { source: fastag.id, transaction: toll.id },
    });
    navigate.mockClear();
    page.goToSource(transaction('bank-transaction', 'synthetic-bank'));
    expect(navigate).toHaveBeenLastCalledWith(['/sources'], { fragment: 'synthetic-bank' });
    navigate.mockClear();
    page.goToSource(transaction('meal-transaction', 'synthetic-meal'));
    expect(navigate).toHaveBeenLastCalledWith(['/sources'], { fragment: 'synthetic-meal' });
    navigate.mockClear();
    page.goToSource(transaction('card-transaction', card.id));
    expect(navigate).toHaveBeenLastCalledWith(['/cards'], { queryParams: { open: card.id } });
    fixture.destroy();
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
  it('orders wallet activity by event time and verifies the transaction filter popup workflow', async () => {
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
      {
        id: 'archived-cash-filter',
        kind: 'CASH',
        nickname: 'Archived cash',
        noLimit: true,
        autoLoad: false,
        archived: true,
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
      '#transaction-filter-trigger',
    ) as HTMLButtonElement;
    expect(filterTrigger.textContent?.trim()).toBe('Filter');
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
    expect(getComputedStyle(filterDialog).position).toBe('fixed');
    expect(
      activity.componentInstance
        .sourceFilterOptions()
        .find((option) => option.value === 'archived-cash-filter')?.label,
    ).toContain('Archived');
    const sourcePicker = filterDialog.querySelectorAll('app-select-picker')[1];
    (sourcePicker.querySelector('button') as HTMLButtonElement).click();
    activity.detectChanges();
    const sourceOptions = sourcePicker.querySelector('dialog[open]') as HTMLDialogElement;
    expect(sourceOptions.getAttribute('aria-label')).toBe('Payment source');
    const sourceSearch = sourceOptions.querySelector('input[type="search"]') as HTMLInputElement;
    sourceSearch.value = 'Synthetic Pluxee';
    sourceSearch.dispatchEvent(new Event('input', { bubbles: true }));
    activity.detectChanges();
    const mealOption = [
      ...sourceOptions.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ].find((option) => option.textContent?.includes('Synthetic Pluxee'));
    expect(mealOption).toBeDefined();
    mealOption!.click();
    activity.detectChanges();
    expect(activity.componentInstance.sourceFilter()).toBe('ALL');
    expect(activity.componentInstance.filtered()).toHaveLength(2);
    const apply = [...filterDialog.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Apply filters',
    ) as HTMLButtonElement;
    apply.click();
    activity.detectChanges();
    expect(activity.componentInstance.sourceFilter()).toBe('synthetic-meal');
    expect(activity.componentInstance.filtered().map((transaction) => transaction.cardId)).toEqual([
      'synthetic-meal',
      'synthetic-meal',
    ]);

    filterTrigger.click();
    activity.detectChanges();
    activity.componentInstance.updateFilterDraft('search', 'no matching transaction');
    activity.componentInstance.closeFilterPopup();
    expect(activity.componentInstance.search()).toBe('');
    expect(activity.componentInstance.sourceFilter()).toBe('synthetic-meal');
    expect(activity.componentInstance.filtered()).toHaveLength(2);

    filterTrigger.click();
    activity.detectChanges();
    const clear = [...activity.nativeElement.querySelectorAll('button')].find(
      (button: HTMLButtonElement) => button.textContent?.trim() === 'Clear filters',
    ) as HTMLButtonElement;
    clear.click();
    activity.detectChanges();
    activity.componentInstance.applyFilterDraft();
    expect(activity.componentInstance.sourceFilter()).toBe('ALL');
    expect(activity.componentInstance.activeFilterCount()).toBe(0);

    filterTrigger.focus();
    filterTrigger.click();
    activity.detectChanges();
    const escapeDialog = activity.nativeElement.querySelector(
      'app-profile-modal dialog[open]',
    ) as HTMLDialogElement;
    escapeDialog.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    activity.detectChanges();
    await activity.whenStable();
    expect(activity.nativeElement.querySelector('app-profile-modal dialog[open]')).toBeNull();
    expect(document.activeElement).toBe(filterTrigger);

    filterTrigger.click();
    activity.detectChanges();
    const back = new Event('cardnest:back', { cancelable: true });
    window.dispatchEvent(back);
    activity.detectChanges();
    await activity.whenStable();
    expect(back.defaultPrevented).toBe(true);
    expect(activity.nativeElement.querySelector('app-profile-modal dialog[open]')).toBeNull();
    activity.destroy();
  });
  it('keeps the continuous Pluxee balance separate from local-cycle transaction flow', () => {
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
      const meal: PaymentSource = {
        id: 'meal-only',
        kind: 'MEAL',
        nickname: 'Synthetic Pluxee',
        noLimit: false,
        autoLoad: false,
        archived: false,
        balanceMinor: 171424,
      };
      const cash: PaymentSource = {
        id: 'cash-date-test',
        kind: 'CASH',
        nickname: 'Synthetic cash',
        noLimit: true,
        autoLoad: false,
        archived: false,
      };
      store.budgetCycleStartDay.set(25);
      store.paymentSources.set([meal, cash]);
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
        entry('meal-early-topup', meal.id, 'CREDIT', 500000, '2026-10-23'),
        entry('meal-cycle-spend', meal.id, 'PURCHASE', 401900, '2026-10-25'),
        entry('cash-spend', cash.id, 'PURCHASE', 999999, '2026-10-26'),
      ]);
      store.balanceAdjustments.set([
        {
          id: 'meal-audit-only',
          sourceId: meal.id,
          reason: 'CORRECTION',
          previousMinor: 10000,
          newMinor: 60000,
          correctionMinor: 50000,
          createdAt: '2026-11-03T12:00:00Z',
        },
      ]);
      fixture.detectChanges();

      const page = fixture.componentInstance;
      expect(page.currentCycle()).toMatchObject({
        startIso: '2026-10-25',
        endIso: '2026-11-24',
      });
      expect(
        store.transactions().find((transaction) => transaction.id === 'meal-early-topup')
          ?.transactionDate,
      ).toBe('2026-10-23');
      expect(page.topupsThisCycle(meal)).toBe(0);
      expect(page.monthlyUsed(meal)).toBe(401900);
      expect(page.monthlyRemaining(meal)).toBe(-401900);
      expect(meal.balanceMinor).toBe(171424);
      expect(page.pluxeeAvailableBalance(meal)).toBe(page.money(meal.balanceMinor));
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('Current cycle');
      expect(fixture.nativeElement.textContent).toContain('Top-ups recorded');
      expect(fixture.nativeElement.textContent).toContain('Net transaction flow');
      expect(fixture.nativeElement.querySelector('.meal-cycle-explanation')?.textContent).toContain(
        'unspent funds carry forward',
      );
      page.updateSourceFilter(cash.id);
      expect(page.monthlyUsed(meal)).toBe(401900);
      expect(page.monthlyRemaining(meal)).toBe(-401900);

      store.transactions.update((items) => [
        ...items,
        {
          ...entry('meal-topup-in-cycle', meal.id, 'CREDIT', 10000, '2026-10-27'),
          createdAt: '2026-10-27T12:00:00Z',
          updatedAt: '2026-10-27T12:00:00Z',
        },
        {
          ...entry('meal-split', meal.id, 'ADJUSTMENT', 20000, '2026-10-28'),
          adjustmentDirection: 'INCREASE',
          adjustmentPurpose: 'SPLIT_PAYMENT',
        },
        entry('meal-refund', meal.id, 'REFUND', 5000, '2026-10-29'),
        entry('meal-cashback', meal.id, 'CASHBACK', 1000, '2026-10-30'),
        {
          ...entry('meal-balance-correction', meal.id, 'ADJUSTMENT', 8500, '2026-10-30'),
          adjustmentDirection: 'INCREASE',
          adjustmentPurpose: 'BALANCE_RECONCILIATION',
        },
      ]);
      expect(page.topupsThisCycle(meal)).toBe(10000);
      expect(page.monthlyUsed(meal)).toBe(415900);
      expect(page.monthlyRemaining(meal)).toBe(-405900);

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
  it('drafts, clears, cancels and applies transaction visibility filters consistently', () => {
    setup().destroy();
    const store = TestBed.inject(CardNestStore);
    const card: CreditCard = {
      id: 'visibility-card',
      nickname: 'Synthetic card',
      issuerName: 'Fictional Bank',
      lastDigits: '1111',
      network: 'VISA',
      currencyCode: 'INR',
      theme: 'green',
      statementDay: 1,
      dueDateMode: 'DAYS_AFTER_STATEMENT',
      daysAfterStatement: 20,
      adjustDueDateOnWeekend: false,
      openingBalanceMinor: 0,
      remindToSettle: false,
      annualFeeEnabled: false,
      emergencyPhones: [],
      supportEmails: [],
      archived: false,
      createdAt: '2026-10-01',
      updatedAt: '2026-10-01',
    };
    const archived: PaymentSource = {
      id: 'archived-visibility-source',
      kind: 'CASH',
      nickname: 'Archived cash',
      noLimit: true,
      autoLoad: false,
      archived: true,
    };
    store.cards.set([card]);
    store.paymentSources.set([archived]);
    const row = (id: string, cardId: string, type: CardTransaction['type']): CardTransaction => ({
      id,
      cardId,
      type,
      amountMinor: 1000,
      currencyCode: 'INR',
      transactionDate: '2026-10-20',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: '2026-10-20T00:00:00Z',
      updatedAt: '2026-10-20T00:00:00Z',
    });
    store.transactions.set([
      row('card-purchase', card.id, 'PURCHASE'),
      row('card-payment', card.id, 'PAYMENT'),
      row('archived-purchase', archived.id, 'PURCHASE'),
    ]);
    const before = structuredClone(store.transactions());
    const fixture = TestBed.createComponent(TransactionsPage);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    const ids = () =>
      page
        .filtered()
        .map((item) => item.id)
        .sort();

    page.openFilterPopup();
    page.updateFilterDraft('hideCredits', true);
    page.applyFilterDraft();
    expect(ids()).toEqual(['archived-purchase', 'card-purchase']);
    expect(page.activeFilterCount()).toBe(1);
    page.openFilterPopup();
    page.clearFilterDraft();
    expect(page.hideCredits()).toBe(true);
    page.applyFilterDraft();
    expect(ids()).toEqual(['archived-purchase', 'card-payment', 'card-purchase']);

    page.openFilterPopup();
    page.updateFilterDraft('creditCardsOnly', true);
    page.applyFilterDraft();
    expect(ids()).toEqual(['card-payment', 'card-purchase']);
    page.openFilterPopup();
    page.clearFilterDraft();
    page.applyFilterDraft();
    expect(ids()).toEqual(['archived-purchase', 'card-payment', 'card-purchase']);

    page.openFilterPopup();
    page.updateFilterDraft('hideCredits', true);
    page.updateFilterDraft('creditCardsOnly', true);
    page.updateFilterDraft('search', 'Synthetic');
    page.updateDraftGrouping('CYCLE');
    page.applyFilterDraft();
    expect(page.activeFilterCount()).toBe(4);
    page.openFilterPopup();
    page.clearFilterDraft();
    page.closeFilterPopup();
    expect(page.hideCredits()).toBe(true);
    expect(page.creditCardsOnly()).toBe(true);
    expect(page.grouping()).toBe('CYCLE');
    page.openFilterPopup();
    page.clearFilterDraft();
    page.applyFilterDraft();
    expect(page.hideCredits()).toBe(false);
    expect(page.creditCardsOnly()).toBe(false);
    expect(page.grouping()).toBe('MONTH');
    expect(page.activeFilterCount()).toBe(0);

    page.openFilterPopup();
    page.updateFilterDraftSource(archived.id);
    expect(page.filterDraftGrouping()).toBe('CYCLE');
    page.applyFilterDraft();
    expect(ids()).toEqual(['archived-purchase']);
    expect(page.effectiveGrouping()).toBe('CYCLE');
    page.openFilterPopup();
    page.updateFilterDraftSource(card.id);
    expect(page.filterDraftGrouping()).toBe('STATEMENT');
    page.applyFilterDraft();
    expect(page.effectiveGrouping()).toBe('STATEMENT');

    page.hideCredits.set(true);
    page.creditCardsOnly.set(true);
    page.clearFilters();
    expect(page.sourceFilter()).toBe('ALL');
    expect(page.grouping()).toBe('MONTH');
    expect(page.activeFilterCount()).toBe(0);
    expect(store.transactions()).toEqual(before);
    fixture.destroy();
  });
  it.each([
    ['unset', { balanceMinor: undefined, noLimit: false }, 'Balance not set', false],
    [
      'confirmed zero',
      { balanceMinor: 0, noLimit: false, balanceCutoverAt: '2026-10-31T12:00:00Z' },
      '₹0.00',
      true,
    ],
    [
      'positive',
      { balanceMinor: 580000, noLimit: false, balanceCutoverAt: '2026-10-31T12:00:00Z' },
      '₹5,800.00',
      true,
    ],
    [
      'not tracked',
      { balanceMinor: 580000, noLimit: true, balanceCutoverAt: '2026-10-31T12:00:00Z' },
      'Not tracked',
      false,
    ],
    ['missing cutover', { balanceMinor: 580000, noLimit: false }, '₹5,800.00', false],
    [
      'invalid cutover',
      { balanceMinor: 580000, noLimit: false, balanceCutoverAt: 'invalid' },
      '₹5,800.00',
      false,
    ],
    [
      'invalid balance',
      { balanceMinor: 1.5, noLimit: false, balanceCutoverAt: '2026-10-31T12:00:00Z' },
      '₹0.02',
      false,
    ],
  ])(
    'shows one Pluxee available balance and correct Add money state for a %s balance',
    (_, balance, label, enabled) => {
      const fixture = setup();
      const store = TestBed.inject(CardNestStore);
      store.paymentSources.set([
        {
          id: 'single-meal',
          kind: 'MEAL',
          nickname: 'Synthetic Pluxee',
          autoLoad: false,
          archived: false,
          ...balance,
        },
      ]);
      fixture.detectChanges();
      const text = fixture.nativeElement.textContent as string;
      expect(text).not.toContain('Available now');
      expect(text.match(/Available balance/g)).toHaveLength(1);
      expect(fixture.nativeElement.querySelector('.meal-cycle-summary')?.textContent).toContain(
        label,
      );
      const addMoney = fixture.nativeElement.querySelector(
        '.movement-actions button',
      ) as HTMLButtonElement;
      expect(addMoney.textContent).toContain('Add money');
      expect(addMoney.disabled).toBe(!enabled);
      if (!enabled)
        expect(fixture.nativeElement.textContent).toContain(
          'Set your current Pluxee balance first to enable Add money.',
        );
      expect(text).toContain('Set current balance');
      fixture.destroy();
    },
  );
  it('enables Pluxee Add money reactively after Set current balance succeeds', async () => {
    const fixture = setup();
    const store = TestBed.inject(CardNestStore);
    store.paymentSources.set([
      {
        id: 'single-meal',
        kind: 'MEAL',
        nickname: 'Synthetic Pluxee',
        noLimit: false,
        autoLoad: false,
        archived: false,
      },
    ]);
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('.movement-actions button');
    const addMoney = buttons[0] as HTMLButtonElement;
    const setBalance = buttons[1] as HTMLButtonElement;
    expect(addMoney.disabled).toBe(true);
    fixture.componentInstance.openMovement({ mode: 'ADD_MONEY', sourceId: 'single-meal' });
    fixture.detectChanges();
    const addMoneyDialog = fixture.nativeElement.querySelector('app-source-movement-dialog');
    const addAmount = addMoneyDialog.querySelector(
      'input[inputmode="decimal"]',
    ) as HTMLInputElement;
    addAmount.value = '100';
    addAmount.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    expect(addMoneyDialog.textContent).toContain(
      'Set your current Pluxee balance first to enable Add money.',
    );
    (addMoneyDialog.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const saveBalance = vi
      .spyOn(store, 'setSourceBalance')
      .mockImplementation(async (sourceId, balanceMinor) => {
        store.paymentSources.update((sources) =>
          sources.map((source) =>
            source.id === sourceId
              ? {
                  ...source,
                  balanceMinor,
                  balanceSnapshotMinor: balanceMinor,
                  balanceCutoverAt: '2026-11-01T10:00:00Z',
                  balanceCutoverReason: 'MANUAL',
                  noLimit: false,
                }
              : source,
          ),
        );
      });
    setBalance.click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('app-source-movement-dialog');
    const amount = dialog.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
    amount.value = '0';
    amount.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    (dialog.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await fixture.whenStable();
    expect(saveBalance).toHaveBeenCalledWith('single-meal', 0, expect.anything());
    expect(
      (fixture.nativeElement.querySelector('.movement-actions button') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fixture.destroy();
  });
});
