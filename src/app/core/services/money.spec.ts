import { CardTransaction } from '../models/domain';
import { calculateNetSpending, calculateOutstanding, parseMoneyToMinor } from './money';

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
});
