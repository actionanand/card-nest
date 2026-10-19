import {
  CardTransaction,
  CreditCard,
  PaymentSource,
  TransactionType,
} from '../../core/models/domain';

export type SmsKind =
  | 'PURCHASE'
  | 'BANK_DEBIT'
  | 'BANK_CREDIT'
  | 'BANK_TRANSFER'
  | 'CARD_PAYMENT_RECEIVED'
  | 'PAYMENT_INITIATED'
  | 'CASHBACK'
  | 'REFUND'
  | 'PLUXEE_TOPUP'
  | 'PLUXEE_PURCHASE'
  | 'FASTAG_TOLL'
  | 'FASTAG_TOPUP'
  | 'LOAN_DEBIT'
  | 'STATEMENT'
  | 'PAYMENT_REMINDER'
  | 'LOAN_REMINDER';
export type ReviewState =
  'PENDING' | 'REJECTED' | 'IGNORED' | 'IMPORTED' | 'MATCHED_EXISTING' | 'DEFERRED' | 'ERROR';
export interface SmsEvidence {
  eventTime?: string;
  timeZone?: string;
  cardNetwork?: string;
  confidence?: string;
  earnedForPeriod?: string;
  statementDate?: string;
  id: string;
  providerId: string;
  kind: SmsKind;
  amountMinor: number;
  currency: string;
  eventDate: string;
  eventAt: string;
  receivedAt: number;
  dateFallback: boolean;
  merchant?: string;
  cardDigits?: string;
  accountDigits?: string;
  issuer?: string;
  reference?: string;
  reportedBalanceMinor?: number;
  vehicleNumber?: string;
  availableLimitMinor?: number;
  statementTotalMinor?: number;
  minimumDueMinor?: number;
  dueDate?: string;
  evidence: string;
}
export interface SmsCandidate {
  id: string;
  state: ReviewState;
  item: SmsEvidence | null;
  kind: SmsKind;
  eventAt: string;
  transactionId?: string;
}
export interface ScanStatus {
  permission: string;
  enabled: boolean;
  cursorDate: number;
  cursorId: number;
  completedAt: number;
  pages: number;
  scanned: number;
  found: number;
  more: boolean;
  error: string;
}
const LEDGER_TYPES: Partial<Record<SmsKind, TransactionType>> = {
  PURCHASE: 'PURCHASE',
  CARD_PAYMENT_RECEIVED: 'PAYMENT',
  CASHBACK: 'CASHBACK',
  REFUND: 'REFUND',
  PLUXEE_TOPUP: 'CREDIT',
  PLUXEE_PURCHASE: 'PURCHASE',
  FASTAG_TOLL: 'PURCHASE',
  FASTAG_TOPUP: 'CREDIT',
};
export function ledgerType(item: SmsEvidence): TransactionType | undefined {
  return LEDGER_TYPES[item.kind];
}
export function validEvidence(value: unknown): value is SmsEvidence {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item['id'] === 'string' &&
    /^[a-f0-9]{64}$/.test(item['id']) &&
    typeof item['amountMinor'] === 'number' &&
    Number.isSafeInteger(item['amountMinor']) &&
    item['amountMinor'] > 0 &&
    item['currency'] === 'INR' &&
    typeof item['kind'] === 'string' &&
    [
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
      'STATEMENT',
      'PAYMENT_REMINDER',
      'LOAN_REMINDER',
    ].includes(item['kind']) &&
    typeof item['eventDate'] === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(item['eventDate']) &&
    typeof item['eventAt'] === 'string' &&
    Number.isFinite(Date.parse(item['eventAt'])) &&
    typeof item['receivedAt'] === 'number' &&
    typeof item['providerId'] === 'string'
  );
}
export function eligibleSources(
  item: SmsEvidence,
  cards: readonly CreditCard[],
  sources: readonly PaymentSource[],
): readonly string[] {
  if (item.kind.startsWith('PLUXEE'))
    return sources
      .filter(
        (s) =>
          s.kind === 'MEAL' &&
          (!item.cardDigits || !s.lastDigits || s.lastDigits === item.cardDigits),
      )
      .map((s) => s.id);
  if (item.kind.startsWith('FASTAG'))
    return sources
      .filter(
        (s) =>
          s.kind === 'FASTAG' && (!item.vehicleNumber || s.vehicleNumber === item.vehicleNumber),
      )
      .map((s) => s.id);
  if (!ledgerType(item)) return [];
  return cards
    .filter((card) => {
      const issuer = item.issuer?.toLowerCase();
      const issuerMatches =
        !!issuer &&
        (card.issuerName.toLowerCase().includes(issuer) ||
          (issuer === 'amex' && card.network === 'AMERICAN_EXPRESS'));
      const suffixMatches =
        !!item.cardDigits &&
        (card.lastDigits === item.cardDigits ||
          (card.network === 'AMERICAN_EXPRESS' &&
            item.cardDigits.length === 4 &&
            card.lastDigits.endsWith(item.cardDigits)));
      return issuerMatches && suffixMatches && !card.deletedAt;
    })
    .map((card) => card.id);
}
export function existingSuggestions(
  item: SmsEvidence,
  sourceId: string,
  transactions: readonly CardTransaction[],
): readonly CardTransaction[] {
  const type = ledgerType(item);
  return transactions.filter(
    (t) =>
      t.cardId === sourceId &&
      t.type === type &&
      t.amountMinor === item.amountMinor &&
      Math.abs(Date.parse(t.transactionDate) - Date.parse(item.eventDate)) <= 3 * 86400000,
  );
}
export function transferRelationship(a: SmsEvidence, b: SmsEvidence): boolean {
  return (
    !!a.reference &&
    a.reference === b.reference &&
    a.amountMinor === b.amountMinor &&
    ['BANK_DEBIT', 'BANK_CREDIT', 'BANK_TRANSFER', 'PAYMENT_INITIATED'].includes(a.kind) &&
    ['BANK_DEBIT', 'BANK_CREDIT', 'BANK_TRANSFER', 'PAYMENT_INITIATED'].includes(b.kind)
  );
}
