import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import axe from 'axe-core';
import {
  CardTransaction,
  ConsumerWalletEvent,
  ConsumerWallet,
  PaymentGroup,
} from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { ConsumerWalletService } from '../../core/services/consumer-wallet.service';
import { PaymentGroupsPanel } from './payment-groups-panel';
import { AppSelectPicker } from '../../shared/app-select-picker';
import { By } from '@angular/platform-browser';

describe('Combine payments controls', () => {
  const first: CardTransaction = {
    id: 'first',
    cardId: 'meal',
    type: 'PURCHASE',
    amountMinor: 20000,
    currencyCode: 'INR',
    transactionDate: '2026-10-26',
    merchant: 'Local Market with a deliberately long merchant name',
    categoryId: 'other',
    attachmentIds: [],
    createdAt: 'before',
    updatedAt: 'before',
  };
  const store = {
    transactions: signal<readonly CardTransaction[]>([]),
    paymentGroups: signal<readonly PaymentGroup[]>([]),
    sourceDetail: (id: string) => `${id} •••• 4844`,
    sourceName: (id: string) => id,
    combinePayments: vi.fn().mockResolvedValue('group'),
    updatePaymentGroup: vi.fn().mockResolvedValue(undefined),
    removePaymentMember: vi.fn().mockResolvedValue(undefined),
  };
  const walletService = {
    events: signal<readonly ConsumerWalletEvent[]>([]),
    wallets: signal<readonly ConsumerWallet[]>([]),
  };
  beforeEach(() => {
    store.transactions.set([
      first,
      { ...first, id: 'second', cardId: 'upi', amountMinor: 2000 },
      { ...first, id: 'third', cardId: 'card', amountMinor: 3000 },
    ]);
    store.paymentGroups.set([]);
    walletService.events.set([]);
    walletService.wallets.set([]);
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        { provide: CardNestStore, useValue: store },
        { provide: ConsumerWalletService, useValue: walletService },
      ],
    });
  });
  it.each(['light', 'dark'])(
    'uses searchable custom pickers and accessible grouping controls in %s mode',
    async (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      const fixture = TestBed.createComponent(PaymentGroupsPanel);
      fixture.detectChanges();
      await fixture.whenStable();
      const page = fixture.componentInstance;
      const picker = fixture.debugElement.query(By.directive(AppSelectPicker))
        .componentInstance as AppSelectPicker;
      expect(picker.searchable()).toBe(true);
      expect(fixture.nativeElement.querySelector('select')).toBeNull();
      page.chooseTarget('first');
      page.toggle('second');
      page.toggle('third');
      page.step.set(3);
      page.bill.setValue('210');
      fixture.detectChanges();
      expect(page.preview()).toHaveLength(3);
      expect(page.billValue()).toBe(21000);
      expect(fixture.nativeElement.textContent).toContain('overpaid / unresolved');
      const audit = await axe.run(fixture.nativeElement as HTMLElement, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(audit.violations).toEqual([]);
      page.reviewSave();
      fixture.detectChanges();
      expect(page.step()).toBe(4);
      await page.save();
      expect(store.combinePayments).toHaveBeenCalledWith(
        ['second', 'third'],
        'CARD:first',
        expect.objectContaining({ billTotalMinor: 21000 }),
        [],
      );
      document.documentElement.removeAttribute('data-theme');
    },
    30000,
  );
  it('paginates practical large payment lists and preserves a changed target instead of resetting the picker', async () => {
    store.transactions.set(
      Array.from({ length: 55 }, (_, index) => ({ ...first, id: `entry-${index}` })),
    );
    walletService.events.set([]);
    walletService.wallets.set([]);
    const fixture = TestBed.createComponent(PaymentGroupsPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    expect(page.available()).toHaveLength(55);
    expect(page.available().slice(0, page.limit())).toHaveLength(20);
    page.limit.set(60);
    page.chooseTarget('entry-40');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.target()).toBe('CARD:entry-40');
    expect(page.preview()[0].id).toBe('entry-40');
  });
  it('previews and saves a wallet purchase as a typed member beside a card payment', async () => {
    walletService.wallets.set([
      {
        id: 'wallet',
        providerId: 'amazon',
        kind: 'STANDARD',
        nickname: 'Amazon Pay',
        archived: false,
        createdAt: '2026-10-01',
        updatedAt: '2026-10-01',
      },
    ]);
    walletService.events.set([
      {
        id: 'wallet-payment',
        walletId: 'wallet',
        eventType: 'PURCHASE',
        eventDate: '2026-10-26',
        amountMinor: 6000,
        balanceDeltaMinor: -6000,
        merchant: 'Synthetic wallet shop',
        createdAt: '2026-10-26T10:00:00Z',
        updatedAt: '2026-10-26T10:00:00Z',
      },
    ]);
    const fixture = TestBed.createComponent(PaymentGroupsPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    page.chooseTarget('first');
    page.step.set(2);
    fixture.detectChanges();
    page.toggle('wallet-payment');
    expect(page.preview()).toHaveLength(2);
    expect(page.previewTotal()).toBe(26000);
    expect(fixture.nativeElement.textContent).toContain('Consumer wallet · Amazon Pay');
    page.step.set(3);
    page.reviewSave();
    await page.save();
    expect(store.combinePayments).toHaveBeenCalledWith(
      [],
      'CARD:first',
      { title: '', billTotalMinor: null },
      ['wallet-payment'],
    );
    fixture.destroy();
  });
  it('moves from Payments to Review after selecting two same-card same-day purchases', async () => {
    const second: CardTransaction = {
      ...first,
      id: 'same-card-second-purchase',
      amountMinor: 12500,
      merchant: 'Synthetic second purchase',
      createdAt: '2026-10-26T23:59:00Z',
      updatedAt: '2026-10-26T23:59:00Z',
    };
    store.transactions.set([first, second]);
    const fixture = TestBed.createComponent(PaymentGroupsPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    page.chooseTarget(first.id);
    page.step.set(2);
    page.toggle(second.id);
    fixture.detectChanges();
    const review = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button: HTMLButtonElement) => button.textContent?.trim() === 'Review grouping',
    ) as HTMLButtonElement;
    expect(review.disabled).toBe(false);
    review.click();
    fixture.detectChanges();
    expect(page.step()).toBe(3);
    expect(page.previewPaymentCount()).toBe(2);
    expect(store.combinePayments).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it('advances Step 2 to Review for two same-card purchases on the same calendar date', async () => {
    const sameCardSecond: CardTransaction = {
      ...first,
      id: 'same-card-second',
      amountMinor: 12500,
      merchant: 'Synthetic second purchase',
      createdAt: '2026-10-26T23:59:00Z',
      updatedAt: '2026-10-26T23:59:00Z',
    };
    store.transactions.set([first, sameCardSecond]);
    const fixture = TestBed.createComponent(PaymentGroupsPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    page.chooseTarget(first.id);
    page.step.set(2);
    page.toggle(sameCardSecond.id);
    fixture.detectChanges();
    const review = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button: HTMLButtonElement) => button.textContent?.trim() === 'Review grouping',
    ) as HTMLButtonElement;
    expect(review.disabled).toBe(false);
    review.click();
    fixture.detectChanges();
    expect(page.step()).toBe(3);
    expect(page.previewPaymentCount()).toBe(2);
    expect(store.combinePayments).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it('disables third-calendar-date candidates and confirms remove/dissolve before mutating', async () => {
    const nov9 = { ...first, id: 'nov9', transactionDate: '2026-11-09' };
    const nov10 = { ...first, id: 'nov10', transactionDate: '2026-11-10' };
    const nov11 = { ...first, id: 'nov11', transactionDate: '2026-11-11' };
    store.transactions.set([nov9, nov10, nov11]);
    const group: PaymentGroup = {
      id: 'two-date-group',
      kind: 'PAYMENTS',
      anchorId: nov9.id,
      title: 'Two-date bill',
      currency: 'INR',
      billTotalMinor: null,
      createdAt: '2026-11-09T00:00:00Z',
      updatedAt: '2026-11-10T00:00:00Z',
      memberIds: [nov9.id, nov10.id],
      walletMembers: [],
    };
    store.paymentGroups.set([group]);
    const fixture = TestBed.createComponent(PaymentGroupsPanel);
    fixture.componentRef.setInput('groupId', group.id);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    page.step.set(2);
    fixture.detectChanges();
    const third = page.memberChoices().find((entry) => entry.id === nov11.id)!;
    expect(page.dateSpanError(third)).toContain('adjacent calendar dates');
    page.toggle(third.id);
    expect(page.selected().size).toBe(0);

    const groupSummary = fixture.nativeElement.querySelector(
      '.group-management summary',
    ) as HTMLElement;
    groupSummary.click();
    fixture.detectChanges();
    const removeButton = [
      ...fixture.nativeElement.querySelectorAll('.group-member button'),
    ][0] as HTMLButtonElement;
    removeButton.click();
    fixture.detectChanges();
    expect(store.removePaymentMember).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Only this payment’s membership');
    expect(
      fixture.nativeElement.querySelector('app-profile-modal dialog app-confirmation-dialog'),
    ).not.toBeNull();
    const cancelButton = [
      ...fixture.nativeElement.querySelectorAll('.confirmation-dialog button'),
    ].find(
      (button: HTMLButtonElement) => button.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    cancelButton.click();
    fixture.detectChanges();
    expect(store.removePaymentMember).not.toHaveBeenCalled();
    removeButton.click();
    fixture.detectChanges();
    const confirmRemove = [
      ...fixture.nativeElement.querySelectorAll('.confirmation-dialog button'),
    ].find((button: HTMLButtonElement) =>
      button.textContent?.includes('Remove payment'),
    ) as HTMLButtonElement;
    confirmRemove.click();
    await fixture.whenStable();
    expect(store.removePaymentMember).toHaveBeenLastCalledWith('CARD:nov9', false);

    (fixture.nativeElement.querySelector('.dissolve-group') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'All original payments and refunds remain recorded',
    );
    const confirmDissolve = [
      ...fixture.nativeElement.querySelectorAll('.confirmation-dialog button'),
    ].find((button: HTMLButtonElement) =>
      button.textContent?.includes('Dissolve group'),
    ) as HTMLButtonElement;
    confirmDissolve.click();
    await fixture.whenStable();
    expect(store.removePaymentMember).toHaveBeenLastCalledWith(group.id, true);
    fixture.destroy();
  });
  it('disables third-date additions and confirms removal or dissolution before changing membership', async () => {
    const nov9 = { ...first, id: 'nov9', transactionDate: '2026-11-09' };
    const nov10 = { ...first, id: 'nov10', transactionDate: '2026-11-10' };
    const nov11 = { ...first, id: 'nov11', transactionDate: '2026-11-11' };
    store.transactions.set([nov9, nov10, nov11]);
    const group: PaymentGroup = {
      id: 'two-day-group',
      kind: 'PAYMENTS',
      anchorId: nov9.id,
      title: 'Two-date bill',
      currency: 'INR',
      billTotalMinor: null,
      createdAt: '2026-11-09T00:00:00Z',
      updatedAt: '2026-11-10T00:00:00Z',
      memberIds: [nov9.id, nov10.id],
      walletMembers: [],
    };
    store.paymentGroups.set([group]);
    const fixture = TestBed.createComponent(PaymentGroupsPanel);
    fixture.componentRef.setInput('groupId', group.id);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    page.step.set(2);
    fixture.detectChanges();
    const third = page.memberChoices().find((entry) => entry.id === nov11.id)!;
    expect(page.dateSpanError(third)).toContain('two adjacent calendar dates');
    page.toggle(third.id);
    expect(page.selected().size).toBe(0);
    expect(page.error()).toContain('two adjacent calendar dates');

    const manage = fixture.nativeElement.querySelector('.group-management summary') as HTMLElement;
    manage.click();
    fixture.detectChanges();
    const remove = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button: HTMLButtonElement) => button.textContent?.trim() === 'Remove',
    ) as HTMLButtonElement;
    remove.click();
    fixture.detectChanges();
    expect(store.removePaymentMember).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Only this payment’s membership');
    const cancel = [...fixture.nativeElement.querySelectorAll('.confirmation-dialog button')].find(
      (button: HTMLButtonElement) => button.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    cancel.click();
    fixture.detectChanges();
    expect(store.removePaymentMember).not.toHaveBeenCalled();

    remove.click();
    fixture.detectChanges();
    const confirmRemove = [
      ...fixture.nativeElement.querySelectorAll('.confirmation-dialog button'),
    ].find((button: HTMLButtonElement) =>
      button.textContent?.includes('Remove payment'),
    ) as HTMLButtonElement;
    confirmRemove.click();
    await fixture.whenStable();
    expect(store.removePaymentMember).toHaveBeenLastCalledWith('CARD:nov9', false);

    const dissolve = [
      ...fixture.nativeElement.querySelectorAll('.dissolve-group'),
    ][0] as HTMLButtonElement;
    dissolve.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'All original payments and refunds remain recorded',
    );
    const confirmDissolve = [
      ...fixture.nativeElement.querySelectorAll('.confirmation-dialog button'),
    ].find((button: HTMLButtonElement) =>
      button.textContent?.includes('Dissolve group'),
    ) as HTMLButtonElement;
    confirmDissolve.click();
    await fixture.whenStable();
    expect(store.removePaymentMember).toHaveBeenLastCalledWith(group.id, true);
    fixture.destroy();
  });
  it.each([false, true])(
    'paginates 25 wallet payments and excludes refunds from payment count (mixed card member: %s)',
    async (includeCard) => {
      const purchases: ConsumerWalletEvent[] = Array.from({ length: 25 }, (_, index) => ({
        id: `wallet-payment-${index}`,
        walletId: 'wallet',
        eventType: 'PURCHASE',
        eventDate: '2026-10-26',
        amountMinor: 1000,
        balanceDeltaMinor: -1000,
        createdAt: `2026-10-26T10:${String(index).padStart(2, '0')}:00Z`,
        updatedAt: '2026-10-26T10:00:00Z',
      }));
      const refund: ConsumerWalletEvent = {
        ...purchases[0],
        id: 'wallet-payment-refund',
        eventType: 'REFUND',
        amountMinor: 500,
        balanceDeltaMinor: 500,
        reversalOfEventId: purchases[0].id,
        createdAt: '2026-10-27T10:00:00Z',
      };
      walletService.events.set([...purchases, refund]);
      walletService.wallets.set([
        {
          id: 'wallet',
          providerId: 'amazon',
          nickname: 'Amazon Pay',
          kind: 'STANDARD',
          archived: false,
          createdAt: 'before',
          updatedAt: 'before',
        },
      ]);
      const memberIds = includeCard ? ['first'] : [];
      const walletMembers: PaymentGroup['walletMembers'] = [
        ...purchases.map((event, index) => ({
          groupId: 'large-wallet-group',
          walletEventId: event.id,
          memberKind: 'WALLET_PURCHASE' as const,
          memberOrder: index + 1,
          createdAt: 'before',
        })),
        {
          groupId: 'large-wallet-group',
          walletEventId: refund.id,
          memberKind: 'WALLET_REFUND',
          memberOrder: 26,
          createdAt: 'later',
        },
      ];
      const group: PaymentGroup = {
        id: 'large-wallet-group',
        kind: 'PAYMENTS',
        anchorId: includeCard ? 'first' : null,
        title: 'Large wallet payment group',
        currency: 'INR',
        billTotalMinor: null,
        createdAt: 'before',
        updatedAt: 'before',
        memberIds,
        walletMembers,
      };
      store.paymentGroups.set([group]);
      store.transactions.set(includeCard ? [first] : []);
      const fixture = TestBed.createComponent(PaymentGroupsPanel);
      fixture.componentRef.setInput('groupId', group.id);
      fixture.detectChanges();
      await fixture.whenStable();
      const page = fixture.componentInstance;
      page.step.set(2);
      fixture.detectChanges();
      expect(page.paymentCount(group)).toBe(25 + (includeCard ? 1 : 0));
      expect(page.refundCount(group)).toBe(1);
      const summary = fixture.nativeElement.querySelector(
        '.group-management summary',
      ) as HTMLElement;
      expect(summary.textContent).toContain(`${25 + (includeCard ? 1 : 0)} current payments`);
      expect(summary.textContent).toContain('1 refunds in history');
      summary.click();
      fixture.detectChanges();
      const showMore = [...fixture.nativeElement.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Show more members'),
      ) as HTMLButtonElement | undefined;
      expect(showMore).toBeDefined();
      showMore!.click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelectorAll('.group-member')).toHaveLength(
        26 + (includeCard ? 1 : 0),
      );
      fixture.destroy();
    },
    30000,
  );
  it('explains the empty state and offers the normal Add Transaction action', async () => {
    store.transactions.set([]);
    store.paymentGroups.set([]);
    const fixture = TestBed.createComponent(PaymentGroupsPanel);
    const page = fixture.componentInstance;
    const addTransaction = vi.fn();
    page.addTransaction.subscribe(addTransaction);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain(
      'No recorded purchases are available to combine.',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Combine Payments never creates a fictional entry.',
    );
    (fixture.nativeElement.querySelector('.empty-state .btn-primary') as HTMLButtonElement).click();
    expect(addTransaction).toHaveBeenCalledOnce();
    fixture.destroy();
  });
});
