import { CardTransaction, PaymentSource } from '../models/domain';
import { walletAnchorPosition, walletEffectApplies } from './wallet-anchor';

describe('Verified Pluxee balance anchor', () => {
  const wallet: PaymentSource = {
    id: 'synthetic-meal',
    nickname: 'Synthetic Pluxee',
    kind: 'MEAL',
    institution: 'Pluxee',
    noLimit: false,
    autoLoad: false,
    archived: false,
    balanceMinor: 973724,
    balanceCutoverAt: '2026-10-22T23:47:27Z',
    balanceCutoverReason: 'SMS_RECONCILIATION',
    balanceReconciliation: {
      candidateId: 'synthetic-candidate',
      transactionId: 'anchor-topup',
      eventAt: '2026-10-22T23:47:27Z',
      eventAmountMinor: 880000,
      eventType: 'TOPUP',
      savedBalanceMinor: 333124,
      predictedBalanceMinor: 1213124,
      reportedBalanceMinor: 973724,
      correctionMinor: -239400,
      recordedAt: '2026-10-23T00:00:00Z',
    },
  };
  const entry = (changes: Partial<CardTransaction>): CardTransaction => ({
    id: 'synthetic-entry',
    cardId: wallet.id,
    type: 'PURCHASE',
    amountMinor: 50000,
    currencyCode: 'INR',
    transactionDate: '2026-10-23',
    categoryId: 'dining',
    attachmentIds: [],
    createdAt: 'now',
    updatedAt: 'now',
    ...changes,
  });

  it('orders entries against the India-time anchor, not the UTC date', () => {
    expect(walletAnchorPosition(wallet, entry({ transactionDate: '2026-10-22' }))).toBe('BEFORE');
    expect(walletAnchorPosition(wallet, entry({ transactionTime: '05:17:00' }))).toBe('BEFORE');
    expect(walletAnchorPosition(wallet, entry({ transactionTime: '05:18' }))).toBe('AFTER');
    expect(walletAnchorPosition(wallet, entry({ transactionTime: '05:17:27' }))).toBe('UNCERTAIN');
    expect(walletAnchorPosition(wallet, entry({}))).toBe('UNCERTAIN');
    expect(walletAnchorPosition(wallet, entry({ transactionDate: '2026-10-24' }))).toBe('AFTER');
    expect(walletAnchorPosition(wallet, entry({ id: 'anchor-topup' }))).toBe('ANCHOR');
  });

  it('applies later and anchor entries, never earlier history, and keeps legacy behaviour', () => {
    expect(walletEffectApplies(wallet, entry({ transactionDate: '2026-10-22' }))).toBe(false);
    expect(walletEffectApplies(wallet, entry({ transactionDate: '2026-10-24' }))).toBe(true);
    expect(
      walletEffectApplies(
        wallet,
        entry({ transactionDate: '2026-10-24', sourceBalanceApplied: false }),
      ),
    ).toBe(false);
    expect(
      walletEffectApplies(wallet, entry({ id: 'anchor-topup', sourceBalanceApplied: false })),
    ).toBe(true);
    expect(walletEffectApplies(wallet, entry({ sourceBalanceApplied: false }))).toBe(false);
    expect(walletEffectApplies(wallet, entry({}))).toBe(true);
    const manual = { ...wallet, balanceCutoverReason: 'MANUAL' as const };
    expect(walletEffectApplies(manual, entry({ transactionDate: '2026-10-01' }))).toBe(true);
    expect(walletAnchorPosition({ ...wallet, kind: 'FASTAG' }, entry({}))).toBe('NONE');
  });

  it('uses the latest verified reconciliation as the current anchor', () => {
    const later = {
      ...wallet,
      balanceCutoverAt: '2026-10-24T00:30:00Z',
      latestBalanceReconciliation: {
        ...wallet.balanceReconciliation!,
        candidateId: 'later-candidate',
        transactionId: 'later-topup',
        eventAt: '2026-10-24T00:30:00Z',
      },
    };
    expect(walletAnchorPosition(later, entry({ id: 'anchor-topup' }))).toBe('BEFORE');
    expect(walletAnchorPosition(later, entry({ id: 'later-topup' }))).toBe('ANCHOR');
  });
});
