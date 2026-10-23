import { CardTransaction, PaymentSource } from '../models/domain';
import { indiaTodayIso } from './india-date';

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

/**
 * Position of a ledger entry relative to a verified SMS wallet balance.
 * `ANCHOR` is the reconciled event itself; `UNCERTAIN` is same-day activity without a usable time.
 */
export type WalletAnchorPosition = 'NONE' | 'ANCHOR' | 'BEFORE' | 'AFTER' | 'UNCERTAIN';

function indiaTime(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${value('hour')}:${value('minute')}:${value('second')}`;
}

export function walletAnchorPosition(
  source: PaymentSource,
  transaction: Pick<CardTransaction, 'id' | 'transactionDate' | 'transactionTime'>,
): WalletAnchorPosition {
  if (
    source.kind !== 'MEAL' ||
    source.balanceCutoverReason !== 'SMS_RECONCILIATION' ||
    !source.balanceCutoverAt
  )
    return 'NONE';
  const anchor = new Date(source.balanceCutoverAt);
  if (!Number.isFinite(anchor.getTime())) return 'NONE';
  const anchorTransactionId = (source.latestBalanceReconciliation ?? source.balanceReconciliation)
    ?.transactionId;
  if (anchorTransactionId && transaction.id === anchorTransactionId) return 'ANCHOR';
  const anchorDate = indiaTodayIso(anchor);
  if (transaction.transactionDate !== anchorDate)
    return transaction.transactionDate < anchorDate ? 'BEFORE' : 'AFTER';
  if (!transaction.transactionTime || !TIME.test(transaction.transactionTime)) return 'UNCERTAIN';
  const time =
    transaction.transactionTime.length === 5
      ? `${transaction.transactionTime}:00`
      : transaction.transactionTime;
  const anchorTime = indiaTime(anchor);
  return time < anchorTime ? 'BEFORE' : time > anchorTime ? 'AFTER' : 'UNCERTAIN';
}

/**
 * Whether a ledger entry currently contributes to the stored wallet balance.
 * A verified SMS balance already contains every earlier event, so editing, deleting or moving
 * such an entry must not shift it. The reconciled event and later activity behave normally.
 * The result depends only on the entry and the current anchor, keeping apply/reverse symmetric.
 */
export function walletEffectApplies(source: PaymentSource, transaction: CardTransaction): boolean {
  const position = walletAnchorPosition(source, transaction);
  if (position === 'ANCHOR') return true;
  if (position === 'BEFORE') return false;
  return transaction.sourceBalanceApplied !== false;
}
