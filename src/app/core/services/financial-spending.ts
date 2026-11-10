import {
  CardTransaction,
  ConsumerWalletEvent,
  ConsumerWalletExpenseReversal,
} from '../models/domain';
import { spendingContribution } from './money';

export type ConsolidatedSpendingKind =
  'SOURCE_TRANSACTION' | 'RETAINED_WALLET_LOAD' | 'UPI_LITE_EXPENSE_REVERSAL';

export interface ConsolidatedSpendingEntry {
  readonly id: string;
  readonly kind: ConsolidatedSpendingKind;
  readonly date: string;
  readonly amountMinor: number;
  readonly categoryId: string;
  readonly sourceId: string;
  readonly label: string;
  readonly sourceTransactionId?: string;
  readonly walletEventId?: string;
  readonly walletId?: string;
}

export function projectConsolidatedSpending(
  transactions: readonly CardTransaction[],
  walletEvents: readonly ConsumerWalletEvent[],
  walletExpenseReversals: readonly ConsumerWalletExpenseReversal[],
  informationalSourceIds: ReadonlySet<string> = new Set<string>(),
): readonly ConsolidatedSpendingEntry[] {
  const entries: ConsolidatedSpendingEntry[] = transactions.flatMap((transaction) => {
    if (informationalSourceIds.has(transaction.cardId)) return [];
    const contribution = spendingContribution(transaction);
    return contribution
      ? [
          {
            id: `TRANSACTION:${transaction.id}`,
            kind: 'SOURCE_TRANSACTION',
            date: transaction.transactionDate,
            amountMinor: contribution,
            categoryId: transaction.categoryId,
            sourceId: transaction.cardId,
            label: transaction.merchant || transaction.type.replaceAll('_', ' '),
            sourceTransactionId: transaction.id,
          },
        ]
      : [];
  });
  const transactionIds = new Set(transactions.map((transaction) => transaction.id));
  const eventById = new Map(walletEvents.map((event) => [event.id, event]));
  for (const event of walletEvents) {
    if (
      event.eventType !== 'FUNDED_LOAD' ||
      (event.sourceTransactionId !== undefined && transactionIds.has(event.sourceTransactionId)) ||
      !event.fundingSourceId ||
      !Number.isSafeInteger(event.debitAmountMinor) ||
      (event.debitAmountMinor ?? 0) <= 0
    )
      continue;
    entries.push({
      id: `WALLET_LOAD:${event.id}`,
      kind: 'RETAINED_WALLET_LOAD',
      date: event.eventDate,
      amountMinor: event.debitAmountMinor!,
      categoryId: event.fundingCategoryId ?? event.categoryId ?? 'other',
      sourceId: event.fundingSourceId,
      label: event.merchant || 'Wallet loading',
      sourceTransactionId: event.sourceTransactionId,
      walletEventId: event.id,
      walletId: event.walletId,
    });
  }
  for (const reversal of walletExpenseReversals) {
    const returnEvent = eventById.get(reversal.returnEventId);
    const creditEvent = eventById.get(reversal.creditEventId);
    const loadEvent = eventById.get(reversal.fundedLoadEventId);
    if (
      returnEvent?.eventType !== 'UPI_LITE_RETURN' ||
      !creditEvent ||
      loadEvent?.eventType !== 'FUNDED_LOAD' ||
      !loadEvent.fundingSourceId ||
      !Number.isSafeInteger(reversal.reversedMinor) ||
      reversal.reversedMinor <= 0
    )
      continue;
    entries.push({
      id: `UPI_LITE_RETURN:${reversal.returnEventId}:${reversal.creditEventId}:${reversal.fundedLoadEventId}`,
      kind: 'UPI_LITE_EXPENSE_REVERSAL',
      date: returnEvent.eventDate,
      amountMinor: -reversal.reversedMinor,
      categoryId: loadEvent.fundingCategoryId ?? loadEvent.categoryId ?? 'other',
      sourceId: loadEvent.fundingSourceId,
      label: 'UPI Lite funded-principal return',
      sourceTransactionId: loadEvent.sourceTransactionId,
      walletEventId: returnEvent.id,
      walletId: returnEvent.walletId,
    });
  }
  return entries.sort(
    (left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
  );
}

export function sumConsolidatedSpending(
  entries: readonly ConsolidatedSpendingEntry[],
  startDate?: string,
  endDate?: string,
): number {
  return entries.reduce(
    (sum, entry) =>
      (startDate === undefined || entry.date >= startDate) &&
      (endDate === undefined || entry.date <= endDate)
        ? sum + entry.amountMinor
        : sum,
    0,
  );
}

export function informationalWalletSpending(
  walletEvents: readonly ConsumerWalletEvent[],
  startDate?: string,
  endDate?: string,
): number {
  return walletEvents.reduce(
    (sum, event) =>
      event.eventType === 'PURCHASE' &&
      (startDate === undefined || event.eventDate >= startDate) &&
      (endDate === undefined || event.eventDate <= endDate)
        ? sum + event.amountMinor
        : sum,
    0,
  );
}

export function netInformationalWalletSpending(
  walletEvents: readonly ConsumerWalletEvent[],
  startDate?: string,
  endDate?: string,
): number {
  return walletEvents.reduce((sum, event) => {
    if (
      (startDate !== undefined && event.eventDate < startDate) ||
      (endDate !== undefined && event.eventDate > endDate)
    )
      return sum;
    if (event.eventType === 'PURCHASE') return sum + event.amountMinor;
    if ((event.eventType === 'REFUND' || event.eventType === 'REVERSAL') && event.reversalOfEventId)
      return sum - event.amountMinor;
    return sum;
  }, 0);
}
