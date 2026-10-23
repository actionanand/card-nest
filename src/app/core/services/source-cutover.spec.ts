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
  it('does not create a historical cutover for a fresh meal wallet', async () => {
    const fresh = { ...wallet, balanceMinor: 0, autoLoad: false };
    store.paymentSources.set([fresh]);
    await store.initialisePreferences();
    expect(store.paymentSources()[0].balanceMinor).toBe(0);
    expect(store.paymentSources()[0].balanceCutoverAt).toBeUndefined();
    expect(store.paymentSources()[0].balanceSnapshotMinor).toBeUndefined();
    expect(store.transactions()).toEqual([]);
  });
  it('preserves an existing snapshot and legacy load preference without replaying credits', () => {
    const cutover = '2026-10-01T12:00:00.000Z';
    store.paymentSources.set([
      { ...wallet, balanceCutoverAt: cutover, balanceSnapshotMinor: 123456 },
    ]);
    expect(store.paymentSources()[0].balanceMinor).toBe(123456);
    expect(store.paymentSources()[0].balanceSnapshotMinor).toBe(123456);
    expect(store.paymentSources()[0].balanceCutoverAt).toBe(cutover);
    expect(store.paymentSources()[0].autoLoad).toBe(true);
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
  it('applies a deliberately duplicated meal purchase as a new event rather than copying a historical exclusion', () => {
    const historical: CardTransaction = {
      id: 'fiction-old',
      cardId: wallet.id,
      type: 'PURCHASE',
      amountMinor: 2000,
      currencyCode: 'INR',
      transactionDate: '2026-10-19',
      categoryId: 'dining',
      sourceBalanceApplied: false,
      attachmentIds: [],
      createdAt: 'before',
      updatedAt: 'before',
    };
    store.addTransaction(historical);
    const duplicate = store.duplicateTransaction(historical.id);
    expect(duplicate?.sourceBalanceApplied).toBe(true);
    expect(store.paymentSources()[0].balanceMinor).toBe(121456);
    store.deleteTransaction(duplicate!.id);
    expect(store.paymentSources()[0].balanceMinor).toBe(123456);
  });
});
