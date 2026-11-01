import { CardTransaction } from '../../core/models/domain';
import { eligiblePaymentMember } from '../../core/services/payment-groups';
import { merchantSimilarity } from './sms-matching';
import { normalizedIssuer, SmsEvidence, SmsKind } from './sms-model';
import { purchaseAnchor } from './sms-purchase-matching';

export const SMS_SPLIT_GAP_MS = 30 * 60 * 1000;
const FINANCIAL = new Set<SmsKind>([
  'PURCHASE',
  'BANK_DEBIT',
  'BANK_CREDIT',
  'BANK_TRANSFER',
  'CARD_PAYMENT_RECEIVED',
  'PAYMENT_INITIATED',
  'CASHBACK',
  'REFUND',
  'PLUXEE_TOPUP',
  'PLUXEE_PURCHASE',
  'FASTAG_TOLL',
  'FASTAG_TOPUP',
  'LOAN_DEBIT',
]);
export interface SmsSequenceAlert {
  id: string;
  kind: SmsKind;
  item: SmsEvidence | null;
  receivedAt: number | null;
  transactionId?: string;
  state: string;
  discoveryOrder: number;
}
export interface SmsSplitProposal {
  targetId: string;
  previousCandidateId: string;
  previousTransactionId: string;
  approximate: boolean;
  reason: string;
}

function eligible(item: SmsEvidence | null): item is SmsEvidence {
  return (
    !!item &&
    ((item.kind === 'PURCHASE' && (item.parserVersion ?? 0) >= 3) ||
      item.kind === 'PLUXEE_PURCHASE' ||
      (item.kind === 'BANK_DEBIT' && item.direction === 'DEBIT' && item.purposeHint === 'PURCHASE'))
  );
}
function localDate(time: number): string {
  const date = new Date(time + 330 * 60000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}
function receiptValid(value: number | null): value is number {
  return (
    value !== null && Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())
  );
}
function timingValid(alert: SmsSequenceAlert): boolean {
  const item = alert.item;
  if (
    !item ||
    !receiptValid(alert.receivedAt) ||
    item.dateFallback ||
    localDate(alert.receivedAt) !== item.eventDate
  )
    return false;
  const anchor = purchaseAnchor(item);
  if (item.eventTimeExplicit === true && anchor.kind !== 'EXPLICIT_TRANSACTION_TIME') return false;
  return (
    anchor.kind !== 'EXPLICIT_TRANSACTION_TIME' ||
    (anchor.timestamp !== null &&
      anchor.timestamp <= alert.receivedAt + 120000 &&
      alert.receivedAt - anchor.timestamp <= SMS_SPLIT_GAP_MS)
  );
}
function identityKeys(alert: SmsSequenceAlert): string[] {
  const item = alert.item;
  const keys = alert.transactionId ? [`ledger:${alert.transactionId}`] : [];
  if (item?.reference && (item.cardDigits || item.accountDigits))
    keys.push(
      `ref:${normalizedIssuer(item.issuer)}:${item.cardDigits ? 'card:' + item.cardDigits : 'account:' + item.accountDigits}:${item.reference}:${item.amountMinor}:${item.currency}:${item.direction ?? item.kind}`,
    );
  return keys;
}

/** Receipt adjacency is mandatory. Merchant similarity and the 18-hour duplicate window never establish continuity. */
export function continuousSmsSplit(
  alerts: readonly SmsSequenceAlert[],
  candidateId: string,
  sourceId: string,
  ledger: readonly CardTransaction[],
): SmsSplitProposal | null {
  if (!sourceId) return null;
  const financial = alerts.filter((alert) => FINANCIAL.has(alert.kind));
  const known = financial
    .filter((alert) => receiptValid(alert.receivedAt))
    .sort((a, b) => a.receivedAt! - b.receivedAt! || a.discoveryOrder - b.discoveryOrder);
  const seen = new Map<string, SmsSequenceAlert>();
  const sequence: SmsSequenceAlert[] = [];
  for (const alert of known) {
    const keys = identityKeys(alert);
    const duplicate = keys.map((key) => seen.get(key)).find(Boolean);
    if (duplicate) {
      if (alert.id === candidateId) return null;
      for (const key of keys) seen.set(key, duplicate);
      continue;
    }
    sequence.push(alert);
    for (const key of keys) seen.set(key, alert);
  }
  const index = sequence.findIndex((alert) => alert.id === candidateId);
  if (index < 1) return null;
  const current = sequence[index],
    previous = sequence[index - 1];
  if (
    !['PENDING', 'DEFERRED'].includes(current.state) ||
    !eligible(current.item) ||
    !eligible(previous.item) ||
    !timingValid(current) ||
    !timingValid(previous)
  )
    return null;
  if (
    financial.some(
      (alert) =>
        !receiptValid(alert.receivedAt) &&
        alert.discoveryOrder >= Math.min(previous.discoveryOrder, current.discoveryOrder) &&
        alert.discoveryOrder <= Math.max(previous.discoveryOrder, current.discoveryOrder),
    )
  )
    return null;
  if (
    sequence.some((alert) => alert.id !== current.id && alert.receivedAt === current.receivedAt) ||
    sequence.some((alert) => alert.id !== previous.id && alert.receivedAt === previous.receivedAt)
  )
    return null;
  const gap = current.receivedAt! - previous.receivedAt!;
  if (gap <= 0 || gap > SMS_SPLIT_GAP_MS || previous.item.eventDate !== current.item.eventDate)
    return null;
  if (
    !previous.item.merchant ||
    !current.item.merchant ||
    (previous.item.merchant.trim().toLowerCase() !== current.item.merchant.trim().toLowerCase() &&
      !merchantSimilarity(previous.item.merchant, current.item.merchant))
  )
    return null;
  if (current.item.reference && current.item.reference === previous.item.reference) return null;
  if (
    current.item.amountMinor === previous.item.amountMinor &&
    (!current.item.reference || !previous.item.reference)
  )
    return null;
  const recorded = ledger.find((entry) => entry.id === previous.transactionId);
  if (
    !recorded ||
    !['IMPORTED', 'MATCHED_EXISTING'].includes(previous.state) ||
    !eligiblePaymentMember(recorded) ||
    recorded.cardId === sourceId ||
    recorded.currencyCode !== current.item.currency ||
    recorded.amountMinor !== previous.item.amountMinor
  )
    return null;
  const a = purchaseAnchor(previous.item),
    b = purchaseAnchor(current.item);
  if (
    a.kind === 'EXPLICIT_TRANSACTION_TIME' &&
    b.kind === 'EXPLICIT_TRANSACTION_TIME' &&
    (b.timestamp! < a.timestamp! || b.timestamp! - a.timestamp! > SMS_SPLIT_GAP_MS)
  )
    return null;
  const approximate =
    a.kind !== 'EXPLICIT_TRANSACTION_TIME' || b.kind !== 'EXPLICIT_TRANSACTION_TIME';
  return {
    targetId: recorded.splitGroupId ?? recorded.id,
    previousCandidateId: previous.id,
    previousTransactionId: recorded.id,
    approximate,
    reason: `Consecutive distinct payments from different sources, ${Math.round(gap / 60000)} minutes apart. ${approximate ? 'Receipt timing is approximate.' : 'Explicit transaction times support the receipt sequence.'} Merchant descriptions are supporting evidence; verify the bill.`,
  };
}
