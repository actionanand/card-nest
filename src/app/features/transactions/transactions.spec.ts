import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  AddOnCardProfile,
  CardTransaction,
  ConsumerWalletEvent,
  CreditCard,
} from '../../core/models/domain';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { CardNestStore } from '../../core/services/card-nest-store';
import { ConsumerWalletService } from '../../core/services/consumer-wallet.service';
import { TransactionsPage } from './transactions';

describe('Transactions wallet purchase approval and lifecycle UI', () => {
  let fixture: ComponentFixture<TransactionsPage>;
  let page: TransactionsPage;
  let wallets: ConsumerWalletService;
  const purchase: ConsumerWalletEvent = {
    id: 'wallet-purchase',
    walletId: 'wallet',
    eventType: 'PURCHASE',
    eventDate: '2026-10-20',
    amountMinor: 20000,
    balanceDeltaMinor: -20000,
    merchant: 'Synthetic shop',
    categoryId: 'other',
    notes: 'Original note',
    createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z',
  };
  const submit = () => new Event('submit', { cancelable: true });
  const click = (label: string) => {
    const button = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    button!.click();
    fixture.detectChanges();
  };
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: SqliteDatabase, useValue: { ready: () => false } }],
    });
    wallets = TestBed.inject(ConsumerWalletService);
    const store = TestBed.inject(CardNestStore);
    store.cards.set([]);
    store.transactions.set([]);
    store.paymentGroups.set([]);
    wallets.wallets.set([
      {
        id: 'wallet',
        providerId: 'amazon-pay',
        kind: 'STANDARD',
        nickname: 'Synthetic wallet',
        archived: false,
        createdAt: '2026-10-01',
        updatedAt: '2026-10-01',
      },
    ]);
    wallets.featureState.set('ENABLED');
    wallets.events.set([purchase]);
    fixture = TestBed.createComponent(TransactionsPage);
    page = fixture.componentInstance;
    fixture.detectChanges();
    vi.spyOn(wallets, 'previewWalletPurchaseRefund').mockImplementation(async (input) => ({
      walletId: purchase.walletId,
      purchaseEventId: purchase.id,
      amountMinor: input.amountMinor,
      alreadyRefundedMinor: page.walletRefundTotalMinor(purchase.id),
      refundableRemainingMinor: page.walletRefundableMinor(purchase) - input.amountMinor,
      provenanceSegments: [],
      confirmationKey: JSON.stringify(input),
    }));
    vi.spyOn(wallets, 'recordWalletPurchaseRefund').mockImplementation(async (input) => {
      const refund: ConsumerWalletEvent = {
        id: input.id,
        walletId: purchase.walletId,
        eventType: 'REFUND',
        reversalOfEventId: purchase.id,
        amountMinor: input.amountMinor,
        balanceDeltaMinor: input.amountMinor,
        eventDate: input.eventDate,
        createdAt: '2026-11-06T10:00:00Z',
        updatedAt: '2026-11-06T10:00:00Z',
      };
      wallets.events.update((events) => [...events, refund]);
      return refund;
    });
    vi.spyOn(wallets, 'previewWalletPurchaseCancellation').mockImplementation(async (input) => ({
      walletId: purchase.walletId,
      purchaseEventId: purchase.id,
      amountMinor: input.amountMinor,
      alreadyRefundedMinor: 0,
      refundableRemainingMinor: 0,
      provenanceSegments: [],
      confirmationKey: 'cancel-reviewed',
    }));
    vi.spyOn(wallets, 'cancelWalletPurchase').mockResolvedValue({
      ...purchase,
      id: 'cancel',
      eventType: 'REVERSAL',
      balanceDeltaMinor: purchase.amountMinor,
      reversalOfEventId: purchase.id,
    });
  });
  afterEach(() => {
    fixture.destroy();
    vi.restoreAllMocks();
  });

  it('opens wallet details and shows informational classification and remaining refund value', () => {
    page.openWalletDetails(purchase);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Synthetic shop');
    expect(fixture.nativeElement.textContent).toContain('already counted when loaded');
    expect(fixture.nativeElement.textContent).toContain('Remaining refundable');
    expect(page.walletRefundableMinor(purchase)).toBe(20000);
  });
  it.each([20000, 5000])(
    'previews and explicitly approves a %i-minor refund, once',
    async (amount) => {
      page.openWalletDetails(purchase);
      page.openWalletRefund(purchase);
      page.walletRefundForm.controls.amount.setValue(String(amount / 100));
      await page.saveWalletRefund(submit());
      fixture.detectChanges();
      expect(wallets.recordWalletPurchaseRefund).not.toHaveBeenCalled();
      expect(fixture.nativeElement.textContent).toContain('Review wallet refund');
      const approval = fixture.nativeElement.querySelector(
        '.wallet-form input[type="checkbox"]',
      ) as HTMLInputElement;
      approval.click();
      fixture.detectChanges();
      await Promise.all([page.saveWalletRefund(submit()), page.saveWalletRefund(submit())]);
      fixture.detectChanges();
      expect(wallets.recordWalletPurchaseRefund).toHaveBeenCalledOnce();
      expect(page.walletRefundableMinor(purchase)).toBe(20000 - amount);
      await page.saveWalletRefund(submit());
      expect(wallets.recordWalletPurchaseRefund).toHaveBeenCalledOnce();
    },
  );
  it.each(['amount', 'eventDate'] as const)(
    'invalidates refund approval when %s changes',
    async (field) => {
      page.openWalletRefund(purchase);
      await page.saveWalletRefund(submit());
      fixture.detectChanges();
      (
        fixture.nativeElement.querySelector(
          '.wallet-form input[type="checkbox"]',
        ) as HTMLInputElement
      ).click();
      expect(page.walletRefundApprovedFor()).not.toBe('');
      page.walletRefundForm.controls[field].setValue(field === 'amount' ? '50' : '2026-11-05');
      fixture.detectChanges();
      expect(page.walletRefundApprovedFor()).toBe('');
      await page.saveWalletRefund(submit());
      expect(wallets.recordWalletPurchaseRefund).not.toHaveBeenCalled();
    },
  );
  it('renders one cancellation dialog and cancelling it makes no financial write', () => {
    page.openWalletDetails(purchase);
    fixture.detectChanges();
    click('Cancel purchase');
    expect(fixture.nativeElement.querySelectorAll('app-confirmation-dialog')).toHaveLength(1);
    const cancel = fixture.nativeElement.querySelector(
      '.confirmation-actions .btn',
    ) as HTMLButtonElement;
    cancel.click();
    fixture.detectChanges();
    expect(page.walletCancellationCandidate()).toBeNull();
    expect(wallets.cancelWalletPurchase).not.toHaveBeenCalled();
  });
  it('confirms cancellation once and prevents concurrent confirmation', async () => {
    page.requestWalletCancellation(purchase);
    fixture.detectChanges();
    await Promise.all([page.confirmWalletCancellation(), page.confirmWalletCancellation()]);
    fixture.detectChanges();
    expect(wallets.cancelWalletPurchase).toHaveBeenCalledOnce();
    expect(page.walletCancellationCandidate()).toBeNull();
  });
  it('preserves archived history and disables financial actions when Wallets is off', () => {
    wallets.wallets.update((items) => items.map((wallet) => ({ ...wallet, archived: true })));
    wallets.featureState.set('DISABLED');
    page.openWalletDetails(purchase);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Synthetic wallet');
    const buttons = fixture.nativeElement.querySelectorAll(
      '.detail-actions button',
    ) as NodeListOf<HTMLButtonElement>;
    expect([...buttons].every((button) => button.disabled)).toBe(true);
    page.openWalletRefund(purchase);
    page.requestWalletCancellation(purchase);
    expect(page.walletRefundPurchaseId()).toBe('');
    expect(page.walletCancellationCandidate()).toBeNull();
  });
  it('shows earlier refunds and the remaining refundable amount', () => {
    const refund: ConsumerWalletEvent = {
      ...purchase,
      id: 'partial',
      eventType: 'REFUND',
      amountMinor: 5000,
      balanceDeltaMinor: 5000,
      reversalOfEventId: purchase.id,
    };
    wallets.events.update((events) => [...events, refund]);
    page.openWalletDetails(refund);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Total refunded');
    expect(page.walletRefundTotalMinor(purchase.id)).toBe(5000);
    expect(page.walletRefundableMinor(purchase)).toBe(15000);
  });
  it('loads metadata and financial fields into the wallet edit form without changing identity', () => {
    page.editWalletPurchase(purchase);
    fixture.detectChanges();
    expect(page.walletPurchaseEditId()).toBe(purchase.id);
    expect(page.form.getRawValue()).toMatchObject({
      merchant: purchase.merchant,
      notes: purchase.notes,
      amount: '200',
      transactionDate: purchase.eventDate,
      consumerWalletId: purchase.walletId,
      cardId: '',
    });
    page.form.patchValue({ notes: 'Edited', amount: '150', transactionDate: '2026-10-21' });
    expect(page.walletPurchaseApprovedFor()).toBe('');
  });
  it.each(['metadata', 'amount/date'])(
    'requires approval before saving %s wallet purchase edits',
    async (kind) => {
      const preview = vi
        .spyOn(wallets, 'previewWalletPurchaseEdit')
        .mockImplementation(async (input) => ({
          walletId: input.walletId,
          amountMinor: input.amountMinor,
          balanceBeforeMinor: 50000,
          balanceAfterMinor: 50000 - input.amountMinor,
          allocations: [],
          confirmationKey: JSON.stringify(input),
        }));
      const update = vi.spyOn(wallets, 'updateWalletPurchase').mockResolvedValue(purchase);
      page.editWalletPurchase(purchase);
      page.form.patchValue(
        kind === 'metadata'
          ? { merchant: 'Edited shop', notes: 'Edited note' }
          : { amount: '150', transactionDate: '2026-10-21' },
      );
      fixture.detectChanges();
      await page.save();
      fixture.detectChanges();
      expect(preview).toHaveBeenCalledOnce();
      expect(update).not.toHaveBeenCalled();
      const approval = fixture.nativeElement.querySelector(
        'fieldset.wallet-load-summary input[type="checkbox"]',
      ) as HTMLInputElement;
      expect(approval).not.toBeNull();
      approval.click();
      fixture.detectChanges();
      await page.save();
      fixture.detectChanges();
      expect(update).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: purchase.id,
          walletId: purchase.walletId,
          ...(kind === 'metadata'
            ? { merchant: 'Edited shop', notes: 'Edited note' }
            : { amountMinor: 15000, eventDate: '2026-10-21' }),
        }),
      );
    },
  );
  it('consumes Android Back to close wallet details without any mutation', () => {
    page.openWalletDetails(purchase);
    fixture.detectChanges();
    const back = new Event('cardnest:back', { cancelable: true });
    window.dispatchEvent(back);
    fixture.detectChanges();
    expect(back.defaultPrevented).toBe(true);
    expect(page.detailWalletEvent()).toBeNull();
    expect(wallets.recordWalletPurchaseRefund).not.toHaveBeenCalled();
  });
  it('attributes and filters manual transactions by Add-On profile while retaining the primary card', () => {
    const store = TestBed.inject(CardNestStore);
    const profile: AddOnCardProfile = {
      id: 'family-profile',
      name: 'Synthetic cardholder',
      relationship: 'Wife',
      network: 'MASTERCARD',
      lastDigits: '2468',
      archived: false,
      createdAt: '2026-10-01',
      updatedAt: '2026-10-01',
    };
    const card: CreditCard = {
      id: 'family-primary',
      nickname: 'Household card',
      issuerName: 'Synthetic issuer',
      lastDigits: '1357',
      network: 'VISA',
      theme: 'green',
      statementDay: 1,
      dueDateMode: 'DAYS_AFTER_STATEMENT',
      daysAfterStatement: 20,
      adjustDueDateOnWeekend: false,
      currencyCode: 'INR',
      openingBalanceMinor: 0,
      remindToSettle: false,
      annualFeeEnabled: false,
      emergencyPhones: [],
      supportEmails: [],
      archived: false,
      addOnProfiles: [profile],
      createdAt: '2026-10-01',
      updatedAt: '2026-10-01',
    };
    const attributed: CardTransaction = {
      id: 'family-attributed-transaction',
      cardId: card.id,
      addOnCardId: profile.id,
      type: 'PURCHASE',
      amountMinor: 1200,
      currencyCode: 'INR',
      transactionDate: '2026-10-20',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: '2026-10-20T10:00:00Z',
      updatedAt: '2026-10-20T10:00:00Z',
    };
    const primaryOnly = { ...attributed, id: 'primary-only', addOnCardId: undefined };
    store.cards.set([card]);
    store.transactions.set([attributed, primaryOnly]);
    page.form.controls.cardId.setValue(card.id);
    page.form.controls.addOnCardId.setValue(profile.id);
    fixture.detectChanges();
    expect(page.addOnProfileOptions()).toContainEqual(
      expect.objectContaining({ value: profile.id, label: profile.name }),
    );
    page.sourceFilter.set(`add-on:${profile.id}`);
    expect(page.filtered().map((transaction) => transaction.id)).toEqual([attributed.id]);
    expect(page.filtered()[0].cardId).toBe(card.id);
    expect(page.visibleTotal()).toBe(-attributed.amountMinor);
    expect(page.addOnProfileForTransaction(attributed)).toMatchObject({ name: profile.name });
    page.openDetails(attributed);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Add-On card · Synthetic cardholder');
    expect(fixture.nativeElement.textContent).toContain('Wife');
    expect(fixture.nativeElement.textContent).not.toContain('Relationship');
    expect(fixture.nativeElement.textContent).not.toContain('•••• 2468');
  });
  it('places a combined purchase once inside its chronological period and preserves real totals', () => {
    const store = TestBed.inject(CardNestStore);
    const card: CreditCard = {
      id: 'combined-primary',
      nickname: 'Synthetic card',
      issuerName: 'Synthetic issuer',
      lastDigits: '1357',
      network: 'VISA',
      theme: 'green',
      statementDay: 1,
      dueDateMode: 'DAYS_AFTER_STATEMENT',
      daysAfterStatement: 20,
      adjustDueDateOnWeekend: false,
      currencyCode: 'INR',
      openingBalanceMinor: 0,
      remindToSettle: false,
      annualFeeEnabled: false,
      emergencyPhones: [],
      supportEmails: [],
      archived: false,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
    };
    const transactions: CardTransaction[] = [1000, 2000, 3000].map((amountMinor, index) => ({
      id: `combined-payment-${index + 1}`,
      cardId: card.id,
      type: 'PURCHASE',
      amountMinor,
      currencyCode: 'INR',
      transactionDate: '2026-11-08',
      categoryId: 'other',
      merchant: 'Synthetic merchant',
      attachmentIds: [],
      createdAt: `2026-11-08T10:0${index}:00Z`,
      updatedAt: `2026-11-08T10:0${index}:00Z`,
    }));
    store.cards.set([card]);
    store.transactions.set(transactions);
    wallets.events.set([]);
    store.paymentGroups.set([
      {
        id: 'combined-payment-group',
        kind: 'PAYMENTS',
        anchorId: transactions[0].id,
        title: 'Synthetic group',
        currency: 'INR',
        billTotalMinor: null,
        createdAt: '2026-11-08T10:00:00Z',
        updatedAt: '2026-11-08T10:00:00Z',
        memberIds: transactions.map((transaction) => transaction.id),
        walletMembers: [],
      },
    ]);
    fixture.detectChanges();
    expect(page.logicalGroups()).toHaveLength(1);
    expect(page.pageableActivities()).toHaveLength(1);
    expect(page.pageableActivities()[0].kind).toBe('PAYMENT_GROUP');
    expect(page.visibleTotal()).toBe(-6000);
    expect(fixture.nativeElement.querySelector('.payment-group-summary')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.combined-purchase-entry')).toHaveLength(1);
    expect(fixture.nativeElement.textContent).toContain('Combined purchase');
    expect(fixture.nativeElement.textContent).toContain('3 payments');
  });
});
