import {
  AppliedBalanceEffect,
  BalanceTiming,
  BankCashTrackingSettings,
  CardTransaction,
  PaymentSource,
  SourceTransfer,
} from '../models/domain';
import { indiaTimeOfDay, indiaTodayIso } from './india-date';
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

const EVENT_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

export type BaselinePosition = 'BEFORE' | 'AFTER' | 'UNCERTAIN';

export const TIMING_QUESTION =
  'This has no time and is dated on the day a balance was confirmed. Add the time, or confirm whether it happened after that balance or is already included in it.';

/**
 * Where an event sits relative to a confirmed balance (India time). A date-only event on the
 * confirmation day is UNCERTAIN: the confirmed balance may already include it.
 */
export function baselinePosition(cutoverAt: string, date: string, time?: string): BaselinePosition {
  const cutover = new Date(cutoverAt);
  const baselineDate = indiaTodayIso(cutover);
  if (date !== baselineDate) return date < baselineDate ? 'BEFORE' : 'AFTER';
  if (!time || !EVENT_TIME.test(time)) return 'UNCERTAIN';
  const eventTime = time.length === 5 ? `${time}:00` : time;
  const baselineTime = indiaTimeOfDay(cutover);
  return eventTime < baselineTime ? 'BEFORE' : eventTime > baselineTime ? 'AFTER' : 'UNCERTAIN';
}

export const CORRECTION_QUESTION =
  'This entry existed when the balance was confirmed and is now dated after it. Confirm whether that balance already includes it, or whether it should change the balance now.';

export type BaselineDecision = 'APPLY' | 'SKIP' | 'ASK_TIMING' | 'ASK_CORRECTION';

/** Saved before this balance was confirmed, with no change applied since: it may be inside it. */
export function existedAtBaseline(
  source: { id: string; balanceCutoverAt: string },
  previous: { createdAt: string } | null | undefined,
  effects: readonly (AppliedBalanceEffect | undefined)[] | undefined,
): boolean {
  if (!previous) return false;
  const cutover = Date.parse(source.balanceCutoverAt);
  return (
    !(Date.parse(previous.createdAt) >= cutover) &&
    !(effects ?? []).some(
      (effect) =>
        !!effect && effect.sourceId === source.id && Date.parse(effect.appliedAt) >= cutover,
    )
  );
}

/** For an entry that existed at the balance, only an answer given since that balance counts. */
export function timingAnswer(
  entry: { balanceTiming?: BalanceTiming; balanceTimingAt?: string },
  source: { balanceCutoverAt: string },
  existed: boolean,
): BalanceTiming | undefined {
  if (!entry.balanceTiming || !existed) return entry.balanceTiming;
  return entry.balanceTimingAt &&
    Date.parse(entry.balanceTimingAt) >= Date.parse(source.balanceCutoverAt)
    ? entry.balanceTiming
    : undefined;
}

/**
 * Before the balance: never applies. Reliably after it: applies, unless the entry already
 * existed at the balance and needs a correction answer. Uncertain same-day: follows the answer.
 */
export function baselineDecision(
  source: { balanceCutoverAt: string },
  date: string,
  time: string | undefined,
  answer: BalanceTiming | undefined,
  existed: boolean,
): BaselineDecision {
  const position = baselinePosition(source.balanceCutoverAt, date, time);
  if (position === 'BEFORE') return 'SKIP';
  if (position === 'AFTER' && !existed) return 'APPLY';
  if (answer) return answer === 'AFTER_BASELINE' ? 'APPLY' : 'SKIP';
  return position === 'UNCERTAIN' ? 'ASK_TIMING' : 'ASK_CORRECTION';
}

/** True only where ordering against the balance is genuinely ambiguous for this entry. */
export function needsBaselineConfirmation(
  source: PaymentSource | null | undefined,
  settings: BankCashTrackingSettings,
  date: string,
  time?: string,
  existing?: {
    createdAt: string;
    effects?: readonly (AppliedBalanceEffect | undefined)[];
  } | null,
): boolean {
  if (!bankCashTracked(source, settings)) return false;
  const existed = existedAtBaseline(source, existing, existing?.effects);
  return baselineDecision(source, date, time, undefined, existed).startsWith('ASK');
}

/** The saved answer to pre-select when editing, if it still refers to the current balance. */
export function savedTimingAnswer(
  source: PaymentSource | null | undefined,
  settings: BankCashTrackingSettings,
  entry: CardTransaction | SourceTransfer,
): BalanceTiming | undefined {
  if (!bankCashTracked(source, settings)) return undefined;
  const effects = 'transferDate' in entry ? entry.effects : [entry.balanceEffect];
  return timingAnswer(entry, source, existedAtBaseline(source, entry, effects));
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
 * Applies `next` to its Bank/Cash source after the caller reversed `previous`. The effect is
 * decided afresh on every edit from the event time and the current timing answer, so changing
 * either the date/time or the answer adds or removes the effect exactly once.
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
  const prior = previous?.balanceEffect;
  const priorValid =
    !!prior && prior.sourceId === source.id && effectStillApplies(prior, sources, settings);
  const existed = existedAtBaseline(source, previous, [prior]);
  const decision = baselineDecision(
    source,
    next.transactionDate,
    next.transactionTime,
    timingAnswer(next, source, existed),
    existed,
  );
  if (decision !== 'APPLY') return base;
  const deltaMinor = assetEffect(next);
  if (!deltaMinor) return base;
  source.balanceMinor = checkedBalance(source.balanceMinor + deltaMinor);
  const appliedAt = priorValid ? prior.appliedAt : now;
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
  // A side whose account was re-confirmed later is already inside that confirmed balance.
  for (const effect of transfer?.effects ?? []) reverseBalanceEffect(sources, effect, settings);
}

/**
 * Applies a movement after the caller reversed `previous`. Every tracked side posts together or
 * none does: a movement already covered by one confirmed balance but not another is rejected in
 * strict mode instead of changing only one account. A purely descriptive edit restores exactly
 * the prior effects; any change of amount, accounts, date/time or timing answer is re-decided.
 * One-sided card/loan funding has only a From side.
 */
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
  const descriptiveEdit =
    !!previous &&
    previous.fromSourceId === next.fromSourceId &&
    previous.toSourceId === next.toSourceId &&
    previous.amountMinor === next.amountMinor &&
    previous.transferDate === next.transferDate &&
    (previous.transferTime ?? '') === (next.transferTime ?? '') &&
    previous.balanceTiming === next.balanceTiming &&
    previous.balanceTimingAt === next.balanceTimingAt;
  const decisions = sides.map((side) => {
    const source = side.source!;
    if (!bankCashTracked(source, settings))
      return { side, source, tracked: false, decision: 'SKIP' as BaselineDecision, appliedAt: now };
    const previousSourceId = side.side === 'FROM' ? previous?.fromSourceId : previous?.toSourceId;
    const prior =
      previous && previousSourceId === side.sourceId
        ? previous.effects?.find(
            (effect) =>
              effect.sourceId === side.sourceId &&
              Math.sign(effect.deltaMinor) === Math.sign(side.deltaMinor),
          )
        : undefined;
    const priorValid = !!prior && effectStillApplies(prior, sources, settings);
    const appliedAt = priorValid ? prior.appliedAt : now;
    if (descriptiveEdit) {
      const decision: BaselineDecision = priorValid ? 'APPLY' : 'SKIP';
      return { side, source, tracked: true, decision, appliedAt };
    }
    const existed = existedAtBaseline(source, previous, previous?.effects);
    const decision = baselineDecision(
      source,
      next.transferDate,
      next.transferTime,
      timingAnswer(next, source, existed),
      existed,
    );
    return { side, source, tracked: true, decision, appliedAt };
  });
  const asking = decisions.filter((decision) => decision.decision.startsWith('ASK'));
  if (strict && asking.length)
    throw new Error(
      asking.some((decision) => decision.decision === 'ASK_TIMING')
        ? TIMING_QUESTION
        : CORRECTION_QUESTION,
    );
  const applying = decisions.filter((decision) => decision.decision === 'APPLY');
  const covered = decisions.filter((decision) => decision.tracked && decision.decision !== 'APPLY');
  if (strict && !descriptiveEdit && applying.length && covered.length)
    throw new Error(
      `This movement is not after the confirmed balance of ${covered
        .map((decision) => decision.source.nickname)
        .join(' and ')}, but is after that of ${applying
        .map((decision) => decision.source.nickname)
        .join(
          ' and ',
        )}. Recording it would change only one account. Check the date and time, or confirm both balances again.`,
    );
  const effects: AppliedBalanceEffect[] = [];
  for (const decision of applying) {
    decision.source.balanceMinor = checkedBalance(
      (decision.source.balanceMinor ?? 0) + decision.side.deltaMinor,
    );
    effects.push({
      sourceId: decision.source.id,
      deltaMinor: decision.side.deltaMinor,
      appliedAt: decision.appliedAt,
    });
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
