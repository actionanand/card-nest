import { ConsumerWallet } from '../models/domain';
import { parseMoneyToMinor } from './money';

export type WalletLoadingFundingKind = 'CARD' | 'BANK_UPI' | 'UNSUPPORTED';

export interface WalletLoadAmounts {
  readonly debitAmountMinor: number;
  readonly loadedAmountMinor: number;
  readonly feeMinor: number;
}

export function walletLoadConfirmationKey(
  fundingSourceId: string,
  walletId: string,
  eventDate: string,
  amounts: WalletLoadAmounts,
): string {
  return [
    fundingSourceId,
    walletId,
    eventDate,
    amounts.debitAmountMinor,
    amounts.loadedAmountMinor,
    amounts.feeMinor,
  ].join('|');
}

export function walletLoadApprovalMatches(approvedKey: string, currentKey: string): boolean {
  return !!approvedKey && !!currentKey && approvedKey === currentKey;
}

export function eligibleWalletLoadingDestinations(
  wallets: readonly ConsumerWallet[],
  fundingKind: WalletLoadingFundingKind,
): readonly ConsumerWallet[] {
  if (fundingKind === 'UNSUPPORTED') return [];
  return wallets.filter(
    (wallet) => !wallet.archived && (fundingKind === 'BANK_UPI' || wallet.kind === 'STANDARD'),
  );
}

export function resolveWalletLoadAmounts(
  debitAmountMinor: number,
  loadedAmount: string,
): WalletLoadAmounts | null {
  if (!Number.isSafeInteger(debitAmountMinor) || debitAmountMinor <= 0) return null;
  const trimmedAmount = loadedAmount.trim();
  const loadedAmountMinor = trimmedAmount ? parseMoneyToMinor(trimmedAmount) : debitAmountMinor;
  if (
    loadedAmountMinor === null ||
    !Number.isSafeInteger(loadedAmountMinor) ||
    loadedAmountMinor <= 0 ||
    loadedAmountMinor > debitAmountMinor
  )
    return null;
  return {
    debitAmountMinor,
    loadedAmountMinor,
    feeMinor: debitAmountMinor - loadedAmountMinor,
  };
}
