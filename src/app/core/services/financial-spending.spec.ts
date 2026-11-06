import { CardTransaction, ConsumerWalletEvent } from '../models/domain';
import {
  informationalWalletSpending,
  netInformationalWalletSpending,
  projectConsolidatedSpending,
  sumConsolidatedSpending,
} from './financial-spending';

const transaction = (changes: Partial<CardTransaction> = {}): CardTransaction => ({
  id: 'load-debit',
  cardId: 'bank',
  type: 'PURCHASE',
  amountMinor: 32000,
  currencyCode: 'INR',
  transactionDate: '2026-10-12',
  categoryId: 'travel',
  attachmentIds: [],
  createdAt: '2026-10-12T10:00:00.000Z',
  updatedAt: '2026-10-12T10:00:00.000Z',
  paymentMethod: 'WALLET_LOADING',
  ...changes,
});

const event = (
  id: string,
  eventType: ConsumerWalletEvent['eventType'],
  changes: Partial<ConsumerWalletEvent> = {},
): ConsumerWalletEvent => ({
  id,
  walletId: 'wallet',
  eventType,
  eventDate: '2026-10-12',
  amountMinor: 30000,
  balanceDeltaMinor: 30000,
  createdAt: '2026-10-12T10:00:00.000Z',
  updatedAt: '2026-10-12T10:00:00.000Z',
  ...changes,
});

describe('consolidated financial projection', () => {
  it('counts a load once on its original date and keeps later wallet purchases informational', () => {
    const load = event('load', 'FUNDED_LOAD', {
      sourceTransactionId: 'load-debit',
      fundingSourceId: 'bank',
      fundingCategoryId: 'travel',
      debitAmountMinor: 32000,
      loadedAmountMinor: 30000,
      feeMinor: 2000,
    });
    const purchase = event('wallet-buy', 'PURCHASE', {
      eventDate: '2026-11-02',
      amountMinor: 20000,
      balanceDeltaMinor: -20000,
    });
    const rows = projectConsolidatedSpending([transaction()], [load, purchase], []);

    expect(sumConsolidatedSpending(rows, '2026-10-01', '2026-10-31')).toBe(32000);
    expect(sumConsolidatedSpending(rows, '2026-11-01', '2026-11-30')).toBe(0);
    expect(informationalWalletSpending([load, purchase], '2026-11-01', '2026-11-30')).toBe(20000);
    expect(rows.filter((row) => row.kind === 'SOURCE_TRANSACTION')).toHaveLength(1);
  });

  it('uses only durable funded-principal reversals on the actual return date', () => {
    const load = event('load', 'FUNDED_LOAD', {
      fundingSourceId: 'bank',
      fundingCategoryId: 'travel',
      sourceTransactionId: 'load-debit',
      debitAmountMinor: 32000,
    });
    const promotion = event('promo', 'PROMOTIONAL_CREDIT', {
      eventDate: '2026-10-15',
      balanceDeltaMinor: 10000,
    });
    const returnEvent = event('return', 'UPI_LITE_RETURN', {
      eventDate: '2026-11-03',
      balanceDeltaMinor: -10000,
    });
    const reversal = {
      returnEventId: 'return',
      creditEventId: 'load',
      fundedLoadEventId: 'load',
      reversedMinor: 6000,
      createdAt: '2026-11-03T10:00:00.000Z',
    } as const;
    const rows = projectConsolidatedSpending(
      [transaction()],
      [load, promotion, returnEvent],
      [reversal],
    );

    expect(sumConsolidatedSpending(rows, '2026-10-01', '2026-10-31')).toBe(32000);
    expect(sumConsolidatedSpending(rows, '2026-11-01', '2026-11-30')).toBe(-6000);
    expect(rows.find((row) => row.kind === 'UPI_LITE_EXPENSE_REVERSAL')).toMatchObject({
      categoryId: 'travel',
      sourceId: 'bank',
      date: '2026-11-03',
      amountMinor: -6000,
    });
  });

  it('retains a historical wallet-load expense if its source transaction was pruned', () => {
    const load = event('load', 'FUNDED_LOAD', {
      fundingSourceId: 'bank',
      fundingCategoryId: 'travel',
      debitAmountMinor: 32000,
    });
    const rows = projectConsolidatedSpending([], [load], []);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'RETAINED_WALLET_LOAD',
      date: '2026-10-12',
      amountMinor: 32000,
      sourceId: 'bank',
    });
  });
  it('leaves included fees counted after a full funded-principal return across a year boundary', () => {
    const debit = transaction({ transactionDate: '2025-12-31' });
    const load = event('load', 'FUNDED_LOAD', {
      eventDate: '2025-12-31',
      sourceTransactionId: debit.id,
      fundingSourceId: 'bank',
      debitAmountMinor: 32000,
      loadedAmountMinor: 30000,
      feeMinor: 2000,
    });
    const returned = event('return', 'UPI_LITE_RETURN', {
      eventDate: '2026-01-01',
      balanceDeltaMinor: -30000,
    });
    const entries = projectConsolidatedSpending(
      [debit],
      [load, returned],
      [
        {
          returnEventId: returned.id,
          creditEventId: load.id,
          fundedLoadEventId: load.id,
          reversedMinor: 30000,
          createdAt: '2026-01-01T10:00:00Z',
        },
      ],
    );
    expect(sumConsolidatedSpending(entries, '2025-01-01', '2025-12-31')).toBe(32000);
    expect(sumConsolidatedSpending(entries, '2026-01-01', '2026-12-31')).toBe(-30000);
    expect(sumConsolidatedSpending(entries)).toBe(2000);
    expect(sumConsolidatedSpending(entries, '2025-12-25', '2026-01-24')).toBe(2000);
  });
  it('reports net informational wallet spending by actual purchase, refund and cancellation dates', () => {
    const purchase = event('wallet-buy', 'PURCHASE', {
      eventDate: '2026-10-31',
      amountMinor: 20000,
      balanceDeltaMinor: -20000,
    });
    const refund = event('wallet-refund', 'REFUND', {
      eventDate: '2026-11-02',
      amountMinor: 5000,
      balanceDeltaMinor: 5000,
      reversalOfEventId: purchase.id,
    });
    const cancellation = event('wallet-cancel', 'REVERSAL', {
      eventDate: '2026-11-03',
      amountMinor: 5000,
      balanceDeltaMinor: 5000,
      reversalOfEventId: purchase.id,
    });
    const unlinked = event('unlinked-refund', 'REFUND', {
      eventDate: '2026-11-04',
      amountMinor: 9000,
      balanceDeltaMinor: 9000,
    });
    const events = [purchase, refund, cancellation, unlinked];

    expect(informationalWalletSpending(events, '2026-10-01', '2026-10-31')).toBe(20000);
    expect(netInformationalWalletSpending(events, '2026-10-01', '2026-10-31')).toBe(20000);
    expect(netInformationalWalletSpending(events, '2026-11-01', '2026-11-30')).toBe(-10000);
    expect(netInformationalWalletSpending([refund, cancellation], '2026-11-01', '2026-11-30')).toBe(
      -10000,
    );
    expect(netInformationalWalletSpending(events, '2026-10-25', '2026-11-24')).toBe(10000);
  });
});
