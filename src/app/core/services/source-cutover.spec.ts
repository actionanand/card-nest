import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SqliteDatabase } from '../data/sqlite-database';
import { CardNestStore } from './card-nest-store';
import { CardTransaction, PaymentSource } from '../models/domain';

describe('wallet balance cutover and manual history', () => {
  let store: CardNestStore;
  const wallet: PaymentSource = {
    id: 'demo-meal',
    kind: 'MEAL',
    nickname: 'Fictional meal wallet',
    balanceMinor: 123456,
    loadAmountMinor: 32100,
    loadDay: 14,
    autoLoad: true,
    noLimit: false,
    archived: false,
  };
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [CardNestStore, { provide: SqliteDatabase, useValue: { ready: signal(false) } }],
    });
    store = TestBed.inject(CardNestStore);
    store.transactions.set([]);
    store.paymentSources.set([{ ...wallet }]);
  });
  it('preserves legacy balances and never materializes another simulated monthly load', () => {
    store.materializeSourceLoads('2026-10-19');
    store.materializeSourceLoads('2027-11-19');
    expect(store.paymentSources()[0].balanceMinor).toBe(123456);
    expect(store.paymentSources()[0].balanceSnapshotMinor).toBe(123456);
    expect(store.paymentSources()[0].autoLoad).toBe(false);
    expect(store.transactions()).toEqual([]);
  });
  it('applies a moved historical entry to its newly selected wallet without replaying the old snapshot', () => {
    store.paymentSources.set([{ ...wallet }, { ...wallet, id: 'other-wallet', balanceMinor: 0 }]);
    const transaction: CardTransaction = {
      id: 'fiction-move',
      cardId: wallet.id,
      type: 'CREDIT',
      amountMinor: 2000,
      currencyCode: 'INR',
      transactionDate: '2026-10-19',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: 'now',
      updatedAt: 'now',
      sourceBalanceApplied: false,
    };
    store.addTransaction(transaction);
    store.updateTransaction({ ...transaction, cardId: 'other-wallet' });
    expect(store.paymentSources()[0].balanceMinor).toBe(123456);
    expect(store.paymentSources()[1].balanceMinor).toBe(2000);
  });
  it('keeps manual adjustment reversals correct and excludes historical snapshot entries from balance replay', () => {
    const transaction: CardTransaction = {
      id: 'fiction-adjust',
      cardId: wallet.id,
      type: 'ADJUSTMENT',
      adjustmentDirection: 'DECREASE',
      amountMinor: 2000,
      currencyCode: 'INR',
      transactionDate: '2026-10-19',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: 'now',
      updatedAt: 'now',
    };
    store.addTransaction(transaction);
    expect(store.paymentSources()[0].balanceMinor).toBe(125456);
    store.deleteTransaction(transaction.id);
    expect(store.paymentSources()[0].balanceMinor).toBe(123456);
    store.addTransaction({
      ...transaction,
      id: 'fiction-historical',
      type: 'CREDIT',
      sourceBalanceApplied: false,
    });
    store.deleteTransaction('fiction-historical');
    expect(store.paymentSources()[0].balanceMinor).toBe(123456);
  });
});
