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
