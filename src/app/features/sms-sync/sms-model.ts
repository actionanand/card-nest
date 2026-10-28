import { suggestCategory } from '../../core/services/category-matcher';
import { CATEGORY_REGISTRY } from '../../core/data/category-definitions';
import {
  BankCashTrackingSettings,
  CardTransaction,
  Category,
  CreditCard,
  PaymentSource,
  SmsPaymentMethod,
  SmsPaymentMethodDetail,
  TransactionType,
} from '../../core/models/domain';
import { purchaseCompatible } from './sms-purchase-matching';
import { matchesTransactionType } from '../../core/services/money';

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
  amountDueMinor?: number;
  dueDate?: string;
  evidence: string;
  /** Movement of the customer's own account. Counterparty wording never sets this. */
  direction?: 'DEBIT' | 'CREDIT';
  counterpartyAccountDigits?: string;
  purposeHint?:
    | 'PURCHASE'
    | 'INCOMING'
    | 'ACCOUNT_TRANSFER'
    | 'CARD_REPAYMENT'
    | 'LOAN_REPAYMENT'
    | 'CASH_WITHDRAWAL';
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
  splitTargetId?: string;
  transactionDate?: string;
  categoryId?: string;
  categoryOverridden?: boolean;
  relatedTransactionId?: string;
  /** Explicit paying bank account for a card payment; never inferred. */
  fundingSourceId?: string;
  /** Answer for a date-only funding deduction on the bank's balance-confirmation day. */
  fundingTiming?: 'AFTER_BASELINE' | 'INCLUDED_IN_BASELINE';
  paymentMethod?: SmsPaymentMethod;
  paymentMethodDetail?: SmsPaymentMethodDetail;
  paymentMethodCustom?: string;
  smsAdditionalComment?: string;
}
export interface PurchaseReviewDraft {
  categoryOverridden?: boolean;
  bankPurpose?: BankPurpose;
  categoryUnavailable?: boolean;
  splitTargetId?: string;
  mode: 'CARD' | 'BANK';
  source: string;
  amount: string;
  merchant: string;
  transactionDate: string;
  category: string;
  existing: string;
  separate: boolean;
  paymentMethod: string;
  paymentMethodDetail: string;
  paymentMethodCustom: string;
  smsAdditionalComment: string;
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
    (item['amountDueMinor'] === undefined ||
      (typeof item['amountDueMinor'] === 'number' &&
        Number.isSafeInteger(item['amountDueMinor']) &&
        item['amountDueMinor'] >= 0)) &&
    (item['balancePosition'] === undefined ||
      ['AFTER', 'BEFORE', 'UNKNOWN'].includes(String(item['balancePosition']))) &&
    (item['direction'] === undefined || ['DEBIT', 'CREDIT'].includes(String(item['direction']))) &&
    (item['counterpartyAccountDigits'] === undefined ||
      /^\d{3,5}$/.test(String(item['counterpartyAccountDigits']))) &&
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

export const BANK_EVIDENCE_KINDS: readonly SmsKind[] = [
  'BANK_DEBIT',
  'BANK_CREDIT',
  'BANK_TRANSFER',
  'PAYMENT_INITIATED',
  'LOAN_DEBIT',
];

export type BankPurpose = 'PURCHASE' | 'INCOME' | 'TRANSFER' | 'CARD_SETTLEMENT' | 'LOAN_REPAYMENT';

export function isBankEvidence(item: SmsEvidence | null | undefined): item is SmsEvidence {
  return !!item && BANK_EVIDENCE_KINDS.includes(item.kind) && !suspectEvidence(item);
}

/** Older staged BANK_TRANSFER evidence has no reliable direction until it is reparsed. */
export function bankDirection(item: SmsEvidence): 'DEBIT' | 'CREDIT' | undefined {
  if (item.direction) return item.direction;
  if (item.kind === 'BANK_CREDIT') return 'CREDIT';
  if (['BANK_DEBIT', 'LOAN_DEBIT', 'PAYMENT_INITIATED'].includes(item.kind)) return 'DEBIT';
  return undefined;
}

/** Purposes the user may explicitly choose. Repayments and loans never become spending. */
export function bankPurposes(
  item: SmsEvidence,
  settings: BankCashTrackingSettings,
): readonly BankPurpose[] {
  if (!isBankEvidence(item)) return [];
  const direction = bankDirection(item);
  if (!direction) return [];
  if (direction === 'CREDIT') return settings.enabled ? ['INCOME', 'TRANSFER'] : ['INCOME'];
  const repayment =
    item.kind === 'PAYMENT_INITIATED' ||
    item.kind === 'LOAN_DEBIT' ||
    item.purposeHint === 'CARD_REPAYMENT' ||
    item.purposeHint === 'LOAN_REPAYMENT';
  const purposes: BankPurpose[] = repayment ? [] : ['PURCHASE'];
  if (settings.enabled && item.kind !== 'LOAN_DEBIT' && item.kind !== 'PAYMENT_INITIATED')
    purposes.push('TRANSFER');
  if (settings.enabled && settings.askCardSettlementFunding && item.kind !== 'LOAN_DEBIT')
    purposes.push('CARD_SETTLEMENT');
  if (settings.enabled && (item.kind === 'LOAN_DEBIT' || item.purposeHint === 'LOAN_REPAYMENT'))
    purposes.push('LOAN_REPAYMENT');
  return purposes;
}

/** Only a plain merchant debit defaults to spending; everything else needs an explicit choice. */
export function defaultBankPurpose(
  item: SmsEvidence,
  settings: BankCashTrackingSettings,
): BankPurpose | '' {
  const purposes = bankPurposes(item, settings);
  if (
    item.kind === 'BANK_DEBIT' &&
    bankDirection(item) === 'DEBIT' &&
    (item.purposeHint === undefined || item.purposeHint === 'PURCHASE') &&
    purposes.includes('PURCHASE')
  )
    return 'PURCHASE';
  return '';
}

export function bankDisplayName(issuer: string | undefined): string | undefined {
  if (!issuer) return undefined;
  const names: Record<string, string> = {
    hsbc: 'HSBC',
    icici: 'ICICI Bank',
    hdfc: 'HDFC Bank',
    axis: 'Axis Bank',
    pnb: 'Punjab National Bank',
    scb: 'Standard Chartered',
    federal: 'Federal Bank',
    idfc: 'IDFC FIRST Bank',
    au: 'AU Small Finance Bank',
    kotak: 'Kotak Mahindra Bank',
    sbi: 'State Bank of India',
    bob: 'Bank of Baroda',
    slice: 'Slice',
  };
  return names[normalizedIssuer(issuer)] ?? issuer;
}

/** Masks expose 3–5 trailing digits; the shorter value must be the tail of the longer one. */
export function accountSuffixMatches(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return /^\d{3,5}$/.test(short) && /^\d{3,5}$/.test(long) && long.endsWith(short);
}

function bankConflicts(source: PaymentSource, issuer: string | undefined): boolean {
  const institution = source.institution?.trim();
  if (!issuer || !institution || institution === 'Primary bank') return false;
  const left = normalizedIssuer(institution);
  const right = normalizedIssuer(issuer);
  const knownBanks = new Set([
    'hsbc',
    'icici',
    'hdfc',
    'axis',
    'pnb',
    'scb',
    'federal',
    'idfc',
    'au',
    'kotak',
    'rbl',
    'sbi',
    'bob',
    'slice',
  ]);
  return knownBanks.has(left) && knownBanks.has(right) && left !== right;
}

/**
 * Enrolled accounts whose suffix and (when known) bank agree with the message.
 * A shared suffix with a different bank is never treated as the same account.
 */
export function matchingBankAccounts(
  item: Pick<SmsEvidence, 'accountDigits' | 'issuer'>,
  sources: readonly PaymentSource[],
): readonly PaymentSource[] {
  return matchingBankAccountCandidates(item, sources).filter((source) => !source.archived);
}

export function matchingBankAccountCandidates(
  item: Pick<SmsEvidence, 'accountDigits' | 'issuer'>,
  sources: readonly PaymentSource[],
): readonly PaymentSource[] {
  return sources.filter(
    (source) =>
      source.kind === 'DEBIT' &&
      !!source.lastDigits &&
      accountSuffixMatches(item.accountDigits, source.lastDigits) &&
      !bankConflicts(source, item.issuer),
  );
}

/** Ids safe to preselect. With tracking on, nothing is guessed for the generic source. */
export function suggestedBankSources(
  item: SmsEvidence,
  sources: readonly PaymentSource[],
  settings: BankCashTrackingSettings,
): readonly string[] {
  const matches = matchingBankAccountCandidates(item, sources);
  if (matches.length) return matches.length === 1 && !matches[0].archived ? [matches[0].id] : [];
  if (settings.enabled) return [];
  const generic = sources.filter(
    (source) => source.kind === 'DEBIT' && !source.archived && !source.lastDigits,
  );
  return generic.length === 1 ? [generic[0].id] : [];
}

/** Message identity conflicts with the chosen account (different suffix or bank). */
export function bankSourceConflict(item: SmsEvidence, source: PaymentSource): string {
  if (source.kind !== 'DEBIT') return 'Choose a bank account for this message.';
  if (
    source.lastDigits &&
    item.accountDigits &&
    !accountSuffixMatches(item.accountDigits, source.lastDigits)
  )
    return 'The message account suffix differs from this bank account.';
  if (bankConflicts(source, item.issuer)) return 'The message bank differs from this account.';
  return '';
}

/** Possible manual duplicates; conflicting verified references are never the same event. */
export function bankExistingSuggestions(
  item: SmsEvidence,
  type: TransactionType,
  sourceId: string,
  transactions: readonly CardTransaction[],
  amountMinor = item.amountMinor,
  eventDate = item.eventDate,
): readonly CardTransaction[] {
  return transactions.filter(
    (entry) =>
      entry.cardId === sourceId &&
      matchesTransactionType(entry, type) &&
      entry.currencyCode === item.currency &&
      entry.amountMinor === amountMinor &&
      (type === 'PURCHASE'
        ? purchaseCompatible(item, entry, sourceId, amountMinor, eventDate)
        : Math.abs(Date.parse(entry.transactionDate) - Date.parse(eventDate)) <= 3 * 86400000) &&
      !(entry.reference && item.reference && entry.reference !== item.reference),
  );
}

/** Compatibility entry point; review screens share the offline matcher. */
export function defaultBankCategory(
  purpose: BankPurpose | '',
  merchant: string | undefined,
  categories: readonly (Pick<Category, 'id' | 'archived' | 'appliesTo'> &
    Partial<Pick<Category, 'name' | 'icon'>>)[],
): string {
  return suggestCategory(
    {
      purpose:
        purpose === 'INCOME' ? 'INCOME' : purpose === 'CARD_SETTLEMENT' ? 'PAYMENT' : 'PURCHASE',
      merchant,
    },
    categories.map((category) => ({
      ...category,
      name:
        category.name ??
        CATEGORY_REGISTRY.categories.find((def) => def.id === category.id)?.name ??
        category.id,
      icon: category.icon ?? 'category',
    })),
  );
}

/** Aliases identify issuers; only cardDigits (never accountDigits) identifies a card. */
export function normalizedIssuer(value: string | undefined): string {
  const compact = (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases: readonly [RegExp, string][] = [
    [/hsbc/, 'hsbc'],
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
  amountMinor = item.amountMinor,
  reviewDate = item.eventDate,
): readonly CardTransaction[] {
  const type = ledgerType(item);
  if (item.kind === 'PURCHASE' && type === 'PURCHASE')
    return transactions.filter((entry) =>
      purchaseCompatible(item, entry, sourceId, amountMinor, reviewDate),
    );
  return transactions.filter(
    (t) =>
      t.cardId === sourceId &&
      matchesTransactionType(t, type) &&
      t.currencyCode === item.currency &&
      t.amountMinor === amountMinor &&
      Math.abs(Date.parse(t.transactionDate) - Date.parse(reviewDate)) <= 3 * 86400000,
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
