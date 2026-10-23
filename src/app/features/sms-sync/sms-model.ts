import {
  CardTransaction,
  Category,
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
  | 'LOAN_REMINDER'
  | 'SCHEDULED_CHARGE';
export type ReviewState =
  'PENDING' | 'REJECTED' | 'IGNORED' | 'IMPORTED' | 'MATCHED_EXISTING' | 'DEFERRED' | 'ERROR';
export type ReconciliationChoice =
  | 'PENDING'
  | 'FULLY_PAID'
  | 'RETAIN_BALANCE'
  | 'APPLY_EVENT'
  | 'REPAIR_EXISTING'
  | 'ADJUST_BALANCE';
export interface SmsEvidence {
  parserVersion?: number;
  standingInstructionReference?: string;
  legacyId?: string;
  eventTimeExplicit?: boolean;
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
  merchantEvidence?: string;
  cardDigits?: string;
  accountDigits?: string;
  issuer?: string;
  reference?: string;
  reportedBalanceMinor?: number;
  balancePosition?: 'AFTER' | 'BEFORE' | 'UNKNOWN';
  vehicleNumber?: string;
  availableLimitMinor?: number;
  statementTotalMinor?: number;
  minimumDueMinor?: number;
  dueDate?: string;
  evidence: string;
}
/** Before v3, extraction did not distinguish upcoming card charges from completed debits. */
export function suspectEvidence(item: SmsEvidence): boolean {
  return (
    item.kind === 'PURCHASE' &&
    !(
      typeof item.parserVersion === 'number' &&
      Number.isInteger(item.parserVersion) &&
      item.parserVersion >= 3
    )
  );
}
export interface ApprovalEdits {
  transactionDate?: string;
  categoryId?: string;
  relatedTransactionId?: string;
}
export interface SmsCandidate {
  id: string;
  state: ReviewState;
  item: SmsEvidence | null;
  kind: SmsKind;
  eventAt: string;
  transactionId?: string;
  readAt?: string | null;
  decision?: string | null;
}
export interface ScanStatus {
  permission: string;
  permissionMessage?: string;
  readGranted?: boolean;
  receiveGranted?: boolean;
  canRequest?: boolean;
  settingsRecommended?: boolean;
  requesting?: boolean;
  backgroundPending?: boolean;
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
  return suspectEvidence(item) ? undefined : LEDGER_TYPES[item.kind];
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
      'SCHEDULED_CHARGE',
    ].includes(item['kind']) &&
    typeof item['eventDate'] === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(item['eventDate']) &&
    typeof item['eventAt'] === 'string' &&
    Number.isFinite(Date.parse(item['eventAt'])) &&
    (item['reportedBalanceMinor'] === undefined ||
      (typeof item['reportedBalanceMinor'] === 'number' &&
        Number.isSafeInteger(item['reportedBalanceMinor']) &&
        item['reportedBalanceMinor'] >= 0)) &&
    (item['balancePosition'] === undefined ||
      ['AFTER', 'BEFORE', 'UNKNOWN'].includes(String(item['balancePosition']))) &&
    typeof item['receivedAt'] === 'number' &&
    typeof item['providerId'] === 'string'
  );
}
export function eligibleSources(
  item: SmsEvidence,
  cards: readonly CreditCard[],
  sources: readonly PaymentSource[],
): readonly string[] {
  if (item.kind.startsWith('PLUXEE')) {
    if (item.accountDigits || (item.issuer && normalizedIssuer(item.issuer) !== 'pluxee'))
      return [];
    const wallets = sources.filter(
      (source) => source.kind === 'MEAL' && isPluxeeSource(source) && !source.archived,
    );
    if (item.cardDigits)
      return /^\d{4,5}$/.test(item.cardDigits)
        ? wallets.filter((source) => source.lastDigits === item.cardDigits).map((s) => s.id)
        : [];
    return !item.accountDigits && wallets.length === 1 ? [wallets[0].id] : [];
  }
  if (item.kind.startsWith('FASTAG'))
    return sources
      .filter(
        (s) =>
          s.kind === 'FASTAG' &&
          !!item.vehicleNumber &&
          s.vehicleNumber === item.vehicleNumber &&
          !s.archived,
      )
      .map((s) => s.id);
  if (!ledgerType(item)) return [];
  return cards
    .filter((card) => {
      const issuer = normalizedIssuer(item.issuer);
      const amex =
        card.network === 'AMERICAN_EXPRESS' || normalizedIssuer(card.issuerName) === 'amex';
      const issuerMatches =
        !issuer || normalizedIssuer(card.issuerName) === issuer || (issuer === 'amex' && amex);
      const suffixMatches =
        !!item.cardDigits &&
        /^\d{4,5}$/.test(item.cardDigits) &&
        (amex ? /^\d{4,5}$/ : /^\d{4}$/).test(card.lastDigits) &&
        (card.lastDigits === item.cardDigits ||
          (amex &&
            Math.min(item.cardDigits.length, card.lastDigits.length) === 4 &&
            card.lastDigits.slice(-4) === item.cardDigits.slice(-4)));
      const historical =
        !card.archived || (!!card.archivedAt && item.eventDate <= card.archivedAt.slice(0, 10));
      return (
        issuerMatches &&
        suffixMatches &&
        !card.deletedAt &&
        historical &&
        card.currencyCode === item.currency
      );
    })
    .map((card) => card.id);
}

export function isPluxeeSource(source: PaymentSource): boolean {
  return (
    normalizedIssuer(source.institution) === 'pluxee' ||
    normalizedIssuer(source.nickname) === 'pluxee'
  );
}

export function defaultPluxeeCategory(
  kind: SmsKind,
  categories: readonly Pick<Category, 'id' | 'archived' | 'appliesTo'>[],
): string {
  const preferred = kind === 'PLUXEE_PURCHASE' ? 'dining' : 'contra-expenses';
  const incompatible = kind === 'PLUXEE_PURCHASE' ? 'CREDIT' : 'EXPENSE';
  return categories.some(
    (category) =>
      category.id === preferred && !category.archived && category.appliesTo !== incompatible,
  )
    ? preferred
    : 'other';
}

/** Aliases identify issuers; only cardDigits (never accountDigits) identifies a card. */
export function normalizedIssuer(value: string | undefined): string {
  const compact = (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases: readonly [RegExp, string][] = [
    [/amex|americanexpress/, 'amex'],
    [/standardchartered|stanchart|^scb$/, 'scb'],
    [/bankofbaroda|bobcard|^bob$/, 'bob'],
    [/statebankofindia|sbicard|^sbi$/, 'sbi'],
    [/hdfc/, 'hdfc'],
    [/icici/, 'icici'],
    [/axis/, 'axis'],
    [/idfc/, 'idfc'],
    [/punjabnational|^pnb/, 'pnb'],
    [/aubank|ausmallfinance/, 'au'],
    [/federal/, 'federal'],
    [/kotak/, 'kotak'],
    [/rbl|ratnakar/, 'rbl'],
    [/sodexo|pluxee/, 'pluxee'],
  ];
  return (
    aliases.find(([pattern]) => pattern.test(compact))?.[1] ??
    compact.replace(/bank|limited|ltd|creditcards?|cards?/g, '')
  );
}

/** Also protects older staged evidence produced before merchant extraction was tightened. */
export function merchantTitle(item: SmsEvidence | null, kind: SmsKind): string {
  const merchant = item?.merchant
    ?.split(
      /https?:\/\/|www\.|\b(?:t&cs|terms and conditions|manage standing instructions|unsubscribe|contact support|ref(?:erence)?|utr|rrn|visit|click|not you|if not you|to dispute|call|sms block|available limit|avl limit)\b/i,
    )[0]
    .replace(/^\s*\d{9,30}\s+/, '')
    .trim()
    .replace(/[.;,\s]+$/, '');
  if (
    merchant &&
    !/^(?:[\d\W]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/.*)?|[a-z0-9]{18,})$/i.test(merchant)
  )
    return merchant;
  const titles: Partial<Record<SmsKind, string>> = {
    PURCHASE: 'Card purchase',
    SCHEDULED_CHARGE: 'Scheduled card charge',
    CARD_PAYMENT_RECEIVED: 'Payment received',
    STATEMENT: 'Credit card statement',
    PAYMENT_REMINDER: 'Payment reminder',
    PAYMENT_INITIATED: 'Payment initiated',
    PLUXEE_PURCHASE: 'Meal wallet purchase',
    PLUXEE_TOPUP: 'Meal wallet top-up',
    FASTAG_TOLL: 'Toll payment',
    FASTAG_TOPUP: 'FASTag top-up',
  };
  return titles[kind] ?? kind.toLowerCase().replaceAll('_', ' ');
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
      t.currencyCode === item.currency &&
      t.amountMinor === item.amountMinor &&
      Math.abs(Date.parse(t.transactionDate) - Date.parse(item.eventDate)) <= 3 * 86400000,
  );
}
export function recurringRelationship(a: SmsEvidence, b: SmsEvidence): boolean {
  return (
    a.id !== b.id &&
    [a.kind, b.kind].includes('SCHEDULED_CHARGE') &&
    [a.kind, b.kind].includes('PURCHASE') &&
    !a.dateFallback &&
    !b.dateFallback &&
    a.eventDate === b.eventDate &&
    a.amountMinor === b.amountMinor &&
    a.currency === b.currency &&
    normalizedIssuer(a.issuer) === normalizedIssuer(b.issuer) &&
    !!a.cardDigits &&
    !!b.cardDigits &&
    (a.cardDigits === b.cardDigits ||
      (normalizedIssuer(a.issuer) === 'amex' &&
        a.cardDigits.slice(-4) === b.cardDigits.slice(-4))) &&
    !!a.merchant &&
    a.merchant.toLowerCase() === b.merchant?.toLowerCase() &&
    !(
      a.standingInstructionReference &&
      b.standingInstructionReference &&
      a.standingInstructionReference !== b.standingInstructionReference
    )
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
