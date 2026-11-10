import { ConsumerWallet } from '../models/domain';
import {
  eligibleWalletLoadingDestinations,
  resolveWalletLoadAmounts,
  walletLoadApprovalMatches,
  walletLoadConfirmationKey,
} from './wallet-loading';

const wallets: readonly ConsumerWallet[] = [
  {
    id: 'standard',
    providerId: 'amazon-pay',
    kind: 'STANDARD',
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'upi-lite',
    providerId: 'upi-lite',
    kind: 'UPI_LITE',
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'archived',
    providerId: 'paytm',
    kind: 'STANDARD',
    archived: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('Wallet Loading form rules', () => {
  it('excludes UPI Lite for credit-card funding and archived wallets for every source', () => {
    expect(eligibleWalletLoadingDestinations(wallets, 'CARD').map((wallet) => wallet.id)).toEqual([
      'standard',
    ]);
  });

  it('allows UPI Lite and standard destinations for Bank/UPI funding', () => {
    expect(
      eligibleWalletLoadingDestinations(wallets, 'BANK_UPI').map((wallet) => wallet.id),
    ).toEqual(['standard', 'upi-lite']);
  });

  it('defaults blank credited amount to the complete debit in minor units', () => {
    expect(resolveWalletLoadAmounts(5200, '  ')).toEqual({
      debitAmountMinor: 5200,
      loadedAmountMinor: 5200,
      feeMinor: 0,
      promotionalMinor: 0,
    });
  });

  it('calculates a partial credit and fee without floating-point arithmetic', () => {
    expect(resolveWalletLoadAmounts(5200, '50.01')).toEqual({
      debitAmountMinor: 5200,
      loadedAmountMinor: 5001,
      feeMinor: 199,
      promotionalMinor: 0,
    });
  });

  it('treats a credit above the source debit as promotional value', () => {
    expect(resolveWalletLoadAmounts(30000, '350')).toEqual({
      debitAmountMinor: 30000,
      loadedAmountMinor: 35000,
      feeMinor: 0,
      promotionalMinor: 5000,
    });
  });

  it('rejects invalid, zero and unsafe credited amounts', () => {
    expect(resolveWalletLoadAmounts(5200, '0')).toBeNull();
    expect(resolveWalletLoadAmounts(5200, 'not money')).toBeNull();
    expect(resolveWalletLoadAmounts(Number.MAX_SAFE_INTEGER + 1, '')).toBeNull();
  });

  it('invalidates explicit approval whenever the displayed load summary changes', () => {
    const amounts = resolveWalletLoadAmounts(5200, '50.01')!;
    const approved = walletLoadConfirmationKey('bank-a', 'wallet-a', '2026-11-02', amounts);
    expect(walletLoadApprovalMatches(approved, approved)).toBe(true);
    expect(
      walletLoadApprovalMatches(
        approved,
        walletLoadConfirmationKey('bank-b', 'wallet-a', '2026-11-02', amounts),
      ),
    ).toBe(false);
    expect(
      walletLoadApprovalMatches(
        approved,
        walletLoadConfirmationKey(
          'bank-a',
          'wallet-b',
          '2026-11-02',
          resolveWalletLoadAmounts(5200, '49.01')!,
        ),
      ),
    ).toBe(false);
  });
});
