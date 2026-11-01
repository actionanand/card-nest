import { CardTransaction, Money, TransactionType } from '../models/domain';
import { preferredMoneyCurrency, preferredMoneyLocale } from './currency-display';

const DECREASING_TYPES = new Set<TransactionType>(['PAYMENT', 'CREDIT', 'CASHBACK', 'REFUND']);

export function parseMoneyToMinor(value: string, fractionDigits = 2): Money | null {
  const normalized = value.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > fractionDigits) return null;
  const factor = 10 ** fractionDigits;
  const result = Number(whole) * factor + Number(fraction.padEnd(fractionDigits, '0'));
  return Number.isSafeInteger(result) ? result : null;
}

export function formatMoney(minor: Money, storedCurrencyCode: string, locale?: string): string {
  // Entity currency remains part of the backup schema; the user preference controls presentation.
  void storedCurrencyCode;
  void locale;
  return new Intl.NumberFormat(preferredMoneyLocale(), {
    style: 'currency',
    currency: preferredMoneyCurrency(),
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

export function transactionEffect(
  transaction: Pick<CardTransaction, 'type' | 'amountMinor' | 'adjustmentDirection'>,
): Money {
  if (transaction.type === 'ADJUSTMENT') {
    return transaction.adjustmentDirection === 'DECREASE'
      ? -transaction.amountMinor
      : transaction.amountMinor;
  }
  return DECREASING_TYPES.has(transaction.type)
    ? -transaction.amountMinor
    : transaction.amountMinor;
}

export function calculateOutstanding(
  openingBalanceMinor: Money,
  transactions: readonly CardTransaction[],
): Money {
  return transactions.reduce(
    (total, transaction) => total + transactionEffect(transaction),
    openingBalanceMinor,
  );
}

export function calculateNetSpending(
  transactions: readonly CardTransaction[],
  refundsReduceSpending = true,
): Money {
  return transactions.reduce(
    (sum, item) => sum + spendingContribution(item, refundsReduceSpending),
    0,
  );
}

/** Reporting classification is separate from the already-applied account balance effect. */
export function spendingContribution(item: CardTransaction, refundsReduceSpending = true): Money {
  if (item.type === 'ADJUSTMENT')
    return item.adjustmentPurpose === 'BALANCE_RECONCILIATION' ? 0 : transactionEffect(item);
  if (['PURCHASE', 'FEE', 'INTEREST'].includes(item.type)) return item.amountMinor;
  return refundsReduceSpending && (item.type === 'REFUND' || item.type === 'CASHBACK')
    ? -item.amountMinor
    : 0;
}

/** Split payment is a purchase purpose, while its persisted enum remains ADJUSTMENT. */
export function isPurchasePayment(
  item: Pick<CardTransaction, 'type' | 'adjustmentPurpose' | 'adjustmentDirection'>,
): boolean {
  return (
    item.type === 'PURCHASE' ||
    (item.type === 'ADJUSTMENT' &&
      item.adjustmentPurpose === 'SPLIT_PAYMENT' &&
      item.adjustmentDirection !== 'DECREASE')
  );
}
export function matchesTransactionType(
  item: CardTransaction,
  type: TransactionType | undefined,
): boolean {
  return type === 'PURCHASE' ? isPurchasePayment(item) : item.type === type;
}

export function transactionLabel(item: CardTransaction): string {
  if (item.type !== 'ADJUSTMENT') return item.type.replaceAll('_', ' ');
  return item.adjustmentPurpose === 'SPLIT_PAYMENT'
    ? 'Split payment'
    : item.adjustmentPurpose === 'BALANCE_RECONCILIATION'
      ? 'Balance reconciliation'
      : 'Legacy adjustment';
}
