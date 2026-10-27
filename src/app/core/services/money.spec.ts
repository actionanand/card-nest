import { CardTransaction } from '../models/domain';
import { configureMoneyDisplay } from './currency-display';
import {
  calculateNetSpending,
  calculateOutstanding,
  formatMoney,
  parseMoneyToMinor,
  spendingContribution,
  transactionEffect,
  transactionLabel,
} from './money';

function transaction(type: CardTransaction['type'], amountMinor: number): CardTransaction {
  return {
    id: crypto.randomUUID(),
    cardId: 'card',
    type,
    amountMinor,
    currencyCode: 'INR',
    transactionDate: '2026-07-14',
    categoryId: 'other',
    attachmentIds: [],
    createdAt: '',
    updatedAt: '',
  };
}

describe('money calculations', () => {
  it('counts actual split parts once, charges fees and interest, and excludes repayments, ordinary credits and verified corrections', () => {
    const items = [
      transaction('PURCHASE', 20000),
      { ...transaction('ADJUSTMENT', 2000), adjustmentPurpose: 'SPLIT_PAYMENT' as const },
      transaction('FEE', 100),
      transaction('INTEREST', 200),
      transaction('REFUND', 500),
      transaction('CASHBACK', 100),
      transaction('PAYMENT', 99999),
      transaction('CREDIT', 99999),
      { ...transaction('ADJUSTMENT', 88888), adjustmentPurpose: 'BALANCE_RECONCILIATION' as const },
    ];
    expect(calculateNetSpending(items)).toBe(21700);
    expect(calculateNetSpending([...items, transaction('PURCHASE', 3000)])).toBe(24700);
    expect(calculateNetSpending(items, false)).toBe(22300);
  });
  it('preserves signed legacy contributions without guessing purpose from merchant wording', () => {
    const decreasing = {
      ...transaction('ADJUSTMENT', 2000),
      adjustmentDirection: 'DECREASE' as const,
    };
    expect(spendingContribution(decreasing)).toBe(-2000);
    expect(transactionEffect(decreasing)).toBe(-2000);
    expect(transactionLabel(decreasing)).toBe('Legacy adjustment');
    expect(calculateNetSpending([decreasing])).toBe(-2000);
    expect(
      spendingContribution({
        ...transaction('ADJUSTMENT', 2000),
        merchant: 'Approved wallet balance reconciliation',
      }),
    ).toBe(2000);
  });
  beforeEach(() => configureMoneyDisplay('IN', 'INR'));

  it('parses decimal input to integer minor units', () => {
    expect(parseMoneyToMinor('1,234.50')).toBe(123450);
    expect(parseMoneyToMinor('12.345')).toBeNull();
  });

  it('handles purchases, refunds, partial payments and overpayments', () => {
    const items = [
      transaction('PURCHASE', 100000),
      transaction('REFUND', 15000),
      transaction('PAYMENT', 90000),
    ];
    expect(calculateOutstanding(0, items)).toBe(-5000);
  });

  it('excludes settlements from spending and optionally offsets refunds', () => {
    const items = [
      transaction('PURCHASE', 100000),
      transaction('REFUND', 20000),
      transaction('PAYMENT', 80000),
    ];
    expect(calculateNetSpending(items)).toBe(80000);
    expect(calculateNetSpending(items, false)).toBe(100000);
  });

  it('changes presentation currency without changing the stored currency', () => {
    configureMoneyDisplay('GB', 'GBP');
    expect(formatMoney(123450, 'INR')).toContain('£');
    expect(formatMoney(123450, 'INR')).toContain('1,234.50');
  });
});
