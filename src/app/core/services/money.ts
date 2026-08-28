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
  const purchases = transactions
    .filter((item) => item.type === 'PURCHASE')
    .reduce((sum, item) => sum + item.amountMinor, 0);
  if (!refundsReduceSpending) return purchases;
  const offsets = transactions
    .filter((item) => item.type === 'REFUND' || item.type === 'CASHBACK')
    .reduce((sum, item) => sum + item.amountMinor, 0);
  return Math.max(0, purchases - offsets);
}
