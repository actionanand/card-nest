import {
  AppliedBalanceEffect,
  BankCashTrackingSettings,
  CardTransaction,
  PaymentSource,
  SourceTransfer,
} from '../models/domain';
import { indiaTodayIso } from './india-date';
import { transactionEffect } from './money';
import { walletEffectApplies } from './wallet-anchor';

export const BANK_CASH_TRACKING_KEY = 'bank_cash_tracking';

export const DEFAULT_BANK_CASH_TRACKING: BankCashTrackingSettings = {
  enabled: false,
  askCardSettlementFunding: false,
};

export function isBankOrCash(source: Pick<PaymentSource, 'kind'> | null | undefined): boolean {
  return source?.kind === 'CASH' || source?.kind === 'DEBIT';
}

export function isEnrolledBankAccount(source: PaymentSource): boolean {
  return source.kind === 'DEBIT' && !!source.lastDigits;
}

export function bankAccountLabel(source: PaymentSource): string {
  if (source.kind === 'CASH') return source.nickname;
  const institution = source.institution?.trim();
  const name = institution && institution !== 'Primary bank' ? institution : source.nickname;
  return source.lastDigits ? `${name} · A/c ••${source.lastDigits}` : name;
}

export function parseBankCashTracking(raw: string | null | undefined): BankCashTrackingSettings {
  if (!raw) return { ...DEFAULT_BANK_CASH_TRACKING };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { ...DEFAULT_BANK_CASH_TRACKING };
    const record = value as Record<string, unknown>;
    return {
      enabled: record['enabled'] === true,
      // Retained while tracking is off; only effective when tracking is on.
      askCardSettlementFunding: record['askCardSettlementFunding'] === true,
      activatedAt: typeof record['activatedAt'] === 'string' ? record['activatedAt'] : undefined,
      disabledAt: typeof record['disabledAt'] === 'string' ? record['disabledAt'] : undefined,
    };
  } catch {
    return { ...DEFAULT_BANK_CASH_TRACKING };
  }
}

/** A Bank/Cash balance is tracked only with the global setting on and a confirmed baseline. */
export function bankCashTracked(
  source: PaymentSource | null | undefined,
  settings: BankCashTrackingSettings,
): source is PaymentSource & { balanceMinor: number; balanceCutoverAt: string } {
  return (
    !!source &&
    isBankOrCash(source) &&
    settings.enabled &&
    typeof source.balanceMinor === 'number' &&
    Number.isSafeInteger(source.balanceMinor) &&
    !!source.balanceCutoverAt &&
    Number.isFinite(Date.parse(source.balanceCutoverAt))
  );
}

/** Asset semantics: card repayments recorded on a bank/cash source never add funds to it. */
export function assetEffect(
  transaction: Pick<CardTransaction, 'type' | 'amountMinor' | 'adjustmentDirection'>,
): number {
  return transaction.type === 'PAYMENT' ? 0 : -transactionEffect(transaction);
}

function checkedBalance(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('Balance would overflow.');
  return value;
}

/** An effect recorded before the latest confirmed balance is already part of that balance. */
function effectStillApplies(
  effect: AppliedBalanceEffect,
  sources: readonly PaymentSource[],
  settings: BankCashTrackingSettings,
): boolean {
  const source = sources.find((item) => item.id === effect.sourceId);
  return (
    bankCashTracked(source, settings) &&
    Date.parse(effect.appliedAt) >= Date.parse(source.balanceCutoverAt)
  );
}

function onOrAfterBaseline(source: { balanceCutoverAt: string }, date: string): boolean {
  return date >= indiaTodayIso(new Date(source.balanceCutoverAt));
}

export function reverseBalanceEffect(
  sources: PaymentSource[],
  effect: AppliedBalanceEffect | undefined,
  settings: BankCashTrackingSettings,
): void {
  if (!effect || !effectStillApplies(effect, sources, settings)) return;
  const source = sources.find((item) => item.id === effect.sourceId)!;
  source.balanceMinor = checkedBalance((source.balanceMinor ?? 0) - effect.deltaMinor);
}

function withoutEffect(transaction: CardTransaction): CardTransaction {
  const copy = { ...transaction };
  delete copy.balanceEffect;
  return copy;
}

/**
 * Applies `next` to its Bank/Cash source after the caller reversed `previous`.
 * An edit keeps the applied/not-applied status of the original entry; a new or moved entry
 * applies only when its event is not earlier than the confirmed balance.
 */
export function applyBankCashTransaction(
  sources: PaymentSource[],
  previous: CardTransaction | null,
  next: CardTransaction,
  settings: BankCashTrackingSettings,
  now: string,
): CardTransaction {
  const base = withoutEffect(next);
  const source = sources.find((item) => item.id === next.cardId);
  if (!bankCashTracked(source, settings) || next.sourceBalanceApplied === false) return base;
  let appliedAt = now;
  if (previous && previous.cardId === next.cardId) {
    const prior = previous.balanceEffect;
    if (!prior || prior.sourceId !== source.id || !effectStillApplies(prior, sources, settings))
      return base;
    appliedAt = prior.appliedAt;
  } else if (!onOrAfterBaseline(source, next.transactionDate)) return base;
  const deltaMinor = assetEffect(next);
  if (!deltaMinor) return base;
  source.balanceMinor = checkedBalance(source.balanceMinor + deltaMinor);
  return { ...base, balanceEffect: { sourceId: source.id, deltaMinor, appliedAt } };
}

/** Existing wallet semantics for Pluxee/FASTAG; Bank/Cash entries use recorded effects. */
export function applyWalletTransaction(
  sources: PaymentSource[],
  transaction: CardTransaction | null,
  direction: 1 | -1,
): void {
  if (!transaction) return;
  const source = sources.find((item) => item.id === transaction.cardId);
  if (!source || isBankOrCash(source) || source.noLimit || source.balanceMinor === undefined)
    return;
  if (!walletEffectApplies(source, transaction)) return;
  source.balanceMinor = checkedBalance(
    source.balanceMinor - transactionEffect(transaction) * direction,
  );
}

export function transferSides(
  transfer: Pick<SourceTransfer, 'fromSourceId' | 'toSourceId' | 'amountMinor'>,
): readonly { sourceId: string; deltaMinor: number; side: 'FROM' | 'TO' }[] {
  return [
    { sourceId: transfer.fromSourceId, deltaMinor: -transfer.amountMinor, side: 'FROM' },
    ...(transfer.toSourceId
      ? [{ sourceId: transfer.toSourceId, deltaMinor: transfer.amountMinor, side: 'TO' as const }]
      : []),
  ];
}

export function reverseTransferEffects(
  sources: PaymentSource[],
  transfer: SourceTransfer | null,
  settings: BankCashTrackingSettings,
): void {
  for (const effect of transfer?.effects ?? []) reverseBalanceEffect(sources, effect, settings);
}

/** Applies both sides after the caller reversed `previous`; strict mode never posts one side. */
export function applyTransferEffects(
  sources: PaymentSource[],
  previous: SourceTransfer | null,
  next: SourceTransfer,
  settings: BankCashTrackingSettings,
  now: string,
  strict = true,
): SourceTransfer {
  if (next.toSourceId && next.toSourceId === next.fromSourceId)
    throw new Error('Choose different From and To accounts.');
  if (!Number.isSafeInteger(next.amountMinor) || next.amountMinor <= 0)
    throw new Error('Enter a valid transfer amount.');
  if (!settings.enabled) {
    if (strict) throw new Error('Turn on Bank & Cash tracking before recording transfers.');
    return { ...next, effects: [] };
  }
  const effects: AppliedBalanceEffect[] = [];
  const sides = transferSides(next).map((side) => ({
    ...side,
    source: sources.find((item) => item.id === side.sourceId),
  }));
  for (const { source } of sides) {
    if (!source || !isBankOrCash(source))
      throw new Error('Transfers are limited to enrolled bank accounts and cash.');
    if (strict && !bankCashTracked(source, settings))
      throw new Error(
        `Set the current balance of ${source.nickname} before recording this movement.`,
      );
  }
  for (const side of sides) {
    const source = side.source;
    if (!bankCashTracked(source, settings)) continue;
    let appliedAt = now;
    const previousSourceId = side.side === 'FROM' ? previous?.fromSourceId : previous?.toSourceId;
    if (previous && previousSourceId === side.sourceId) {
      const prior = previous.effects?.find(
        (effect) =>
          effect.sourceId === side.sourceId &&
          Math.sign(effect.deltaMinor) === Math.sign(side.deltaMinor),
      );
      if (!prior || !effectStillApplies(prior, sources, settings)) continue;
      appliedAt = prior.appliedAt;
    } else if (!onOrAfterBaseline(source, next.transferDate)) continue;
    source.balanceMinor = checkedBalance(source.balanceMinor + side.deltaMinor);
    effects.push({ sourceId: source.id, deltaMinor: side.deltaMinor, appliedAt });
  }
  return { ...next, effects };
}

export function transferKindFor(
  from: PaymentSource,
  to: PaymentSource | undefined,
): SourceTransfer['kind'] {
  if (from.kind === 'DEBIT' && to?.kind === 'CASH') return 'CASH_WITHDRAWAL';
  if (from.kind === 'CASH' && to?.kind === 'DEBIT') return 'CASH_DEPOSIT';
  return 'TRANSFER';
}

export function transferLabel(kind: SourceTransfer['kind']): string {
  return {
    TRANSFER: 'Bank transfer',
    CASH_WITHDRAWAL: 'Cash withdrawal',
    CASH_DEPOSIT: 'Cash deposit',
    CARD_SETTLEMENT: 'Credit-card settlement',
    LOAN_REPAYMENT: 'Loan repayment',
  }[kind];
}

export function validTransferDate(date: string, time?: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date &&
    (!time || /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time))
  );
}

export function liquidTotals(
  sources: readonly PaymentSource[],
  settings: BankCashTrackingSettings,
): { bankMinor: number | null; cashMinor: number | null } {
  const sum = (kind: 'DEBIT' | 'CASH') => {
    const tracked = sources.filter(
      (source) => source.kind === kind && !source.archived && bankCashTracked(source, settings),
    );
    return tracked.length
      ? tracked.reduce((total, source) => total + (source.balanceMinor ?? 0), 0)
      : null;
  };
  return { bankMinor: sum('DEBIT'), cashMinor: sum('CASH') };
}
