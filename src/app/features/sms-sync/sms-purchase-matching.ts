import type { CardTransaction } from '../../core/models/domain';
import type { SmsEvidence } from './sms-model';

export const PURCHASE_WINDOW_MS = 18 * 60 * 60 * 1000;
export interface PurchaseAnchor {
  kind: 'EXPLICIT_TRANSACTION_TIME' | 'SMS_RECEIVED_FALLBACK' | 'REVIEW_DATE_ONLY';
  timestamp: number | null;
  originalEventDate: string;
  localDate: string;
  delayed: boolean;
}

/** Ledger wall-clock times are Indian local times, never UTC or creation times. */
export function purchaseTimestamp(date: string, time: string | undefined): number | null {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !time ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(time)
  )
    return null;
  const midnight = Date.parse(`${date}T00:00:00+05:30`);
  if (!Number.isFinite(midnight) || indiaDate(midnight) !== date) return null;
  const timestamp = Date.parse(`${date}T${time}+05:30`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function indiaDate(timestamp: number): string {
  const date = new Date(timestamp + 330 * 60000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

export function purchaseAnchor(item: SmsEvidence, reviewDate = item.eventDate): PurchaseAnchor {
  const base = { originalEventDate: item.eventDate, localDate: reviewDate, delayed: false };
  if (reviewDate !== item.eventDate) return { ...base, kind: 'REVIEW_DATE_ONLY', timestamp: null };
  const explicit = purchaseTimestamp(item.eventDate, item.eventTime);
  if (
    item.eventTimeExplicit === true &&
    !item.dateFallback &&
    explicit !== null &&
    explicit === Date.parse(item.eventAt)
  )
    return { ...base, kind: 'EXPLICIT_TRANSACTION_TIME', timestamp: explicit };
  const receipt =
    Number.isSafeInteger(item.receivedAt) && Number.isFinite(new Date(item.receivedAt).getTime())
      ? item.receivedAt
      : null;
  return {
    ...base,
    kind: 'SMS_RECEIVED_FALLBACK',
    timestamp: receipt,
    delayed: receipt !== null && indiaDate(receipt) !== item.eventDate,
  };
}

export interface PurchaseTiming {
  anchor: PurchaseAnchor;
  differenceMs: number | null;
  reason: string;
}

/** Timing evidence only. Callers must also enforce source, amount, currency and type. */
export function purchaseTiming(
  item: SmsEvidence,
  entry: CardTransaction,
  reviewDate = item.eventDate,
): PurchaseTiming | null {
  const anchor = purchaseAnchor(item, reviewDate);
  const timestamp = purchaseTimestamp(entry.transactionDate, entry.transactionTime);
  if (timestamp === null || anchor.timestamp === null) {
    if (entry.transactionDate !== anchor.localDate) return null;
    return {
      anchor,
      differenceMs: null,
      reason:
        'Same local date only; recorded time is unavailable or the review date was edited. Manual confirmation required.',
    };
  }
  // A delayed alert must not be confused with a new purchase on its delivery day.
  if (anchor.delayed && entry.transactionDate !== item.eventDate) return null;
  const differenceMs = Math.abs(anchor.timestamp - timestamp);
  if (differenceMs > PURCHASE_WINDOW_MS) return null;
  return {
    anchor,
    differenceMs,
    reason:
      anchor.kind === 'EXPLICIT_TRANSACTION_TIME'
        ? 'Same source, amount and type; recorded transaction times are within 18 hours.'
        : 'Within 18 hours of SMS receipt (approximate only). Verify the original event date and purchase.',
  };
}

export function purchaseCompatible(
  item: SmsEvidence,
  entry: CardTransaction,
  sourceId: string,
  amountMinor = item.amountMinor,
  reviewDate = item.eventDate,
): boolean {
  return (
    entry.cardId === sourceId &&
    entry.type === 'PURCHASE' &&
    entry.currencyCode === item.currency &&
    entry.amountMinor === amountMinor &&
    !(item.reference && entry.reference && item.reference !== entry.reference) &&
    // Proven reference identity is independent of the proximity window (e.g. delayed delivery).
    (purchaseTiming(item, entry, reviewDate) !== null ||
      (!!item.reference && item.reference === entry.reference))
  );
}
