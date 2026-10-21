import { walletComparison } from './sms-matching';
import { SmsEvidence } from './sms-model';
import { CardTransaction, PaymentSource } from '../../core/models/domain';

describe('Meal wallet snapshot chronology', () => {
  const item: SmsEvidence = {
    id: 'a'.repeat(64),
    providerId: 'synthetic',
    kind: 'PLUXEE_PURCHASE',
    amountMinor: 2000,
    currency: 'INR',
    eventDate: '2026-10-10',
    eventAt: '2026-10-10T12:00:00Z',
    receivedAt: 1,
    dateFallback: false,
    balancePosition: 'AFTER',
    reportedBalanceMinor: 8000,
    evidence: 'Synthetic',
  };
  const source: PaymentSource = {
    id: 'meal',
    nickname: 'Synthetic',
    kind: 'MEAL',
    noLimit: false,
    balanceMinor: 10000,
    archived: false,
    autoLoad: false,
  };
  const entry: CardTransaction = {
    id: 'manual',
    cardId: 'meal',
    type: 'PURCHASE',
    amountMinor: 2000,
    currencyCode: 'INR',
    transactionDate: item.eventDate,
    categoryId: 'other',
    attachmentIds: [],
    createdAt: 'before',
    updatedAt: 'before',
  };
  it('predicts one debit for a pending purchase and no second debit for a recorded purchase', () => {
    expect(walletComparison(item, source, [])).toMatchObject({
      expected: 8000,
      difference: 0,
      canAdjust: true,
    });
    expect(
      walletComparison(item, { ...source, balanceMinor: 8000 }, [entry], entry.id),
    ).toMatchObject({ expected: 8000, difference: 0 });
  });
  it('predicts a top-up as an increase', () => {
    expect(
      walletComparison({ ...item, kind: 'PLUXEE_TOPUP', reportedBalanceMinor: 12000 }, source, []),
    ).toMatchObject({ expected: 12000, difference: 0 });
  });
  it('compares a before-event snapshot against the before-event balance while separately predicting the resulting ledger', () => {
    expect(
      walletComparison(
        { ...item, balancePosition: 'BEFORE', reportedBalanceMinor: 10000 },
        source,
        [],
      ),
    ).toMatchObject({ expected: 10000, expectedAfter: 8000, difference: 0, canAdjust: false });
    expect(
      walletComparison(
        { ...item, balancePosition: 'BEFORE', reportedBalanceMinor: 10000 },
        { ...source, balanceMinor: 8000 },
        [entry],
        entry.id,
      ),
    ).toMatchObject({ expected: 10000, expectedAfter: 8000, difference: 0, canAdjust: false });
  });
  it.each([
    { balancePosition: 'UNKNOWN' as const },
    { balancePosition: 'BEFORE' as const },
    { dateFallback: true },
  ])('does not offer adjustments for uncertain snapshots %j', (overrides) => {
    expect(walletComparison({ ...item, ...overrides }, source, [])?.canAdjust).toBe(false);
  });
  it('preserves cutover balances and blocks newer or same-day activity', () => {
    expect(
      walletComparison(item, { ...source, balanceCutoverAt: '2026-10-11T12:00:00Z' }, []),
    ).toMatchObject({ expected: 10000, canAdjust: false });
    expect(
      walletComparison(item, source, [{ ...entry, transactionDate: '2026-10-11' }])?.canAdjust,
    ).toBe(false);
  });
});
