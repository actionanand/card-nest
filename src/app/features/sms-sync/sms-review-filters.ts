export const SMS_REVIEW_FILTERS_KEY = 'sms_review_filters';
export const SMS_KINDS = [
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
] as const;
export const INITIAL_MULTIPLE_KINDS = [
  'PURCHASE',
  'CASHBACK',
  'PLUXEE_PURCHASE',
  'PLUXEE_TOPUP',
  'BANK_DEBIT',
];

export interface SmsReviewFilters {
  state: string;
  kind: string;
  search: string;
  source: string;
  from: string;
  to: string;
  read: string;
  mode: 'SINGLE' | 'MULTIPLE';
  kinds: string[];
  multipleInitialized: boolean;
}

export function defaultReviewFilters(): SmsReviewFilters {
  return {
    state: 'PENDING',
    kind: 'ALL',
    search: '',
    source: '',
    from: '',
    to: '',
    read: 'UNREAD',
    mode: 'SINGLE',
    kinds: [],
    multipleInitialized: false,
  };
}

/** Saved preferences and restored backups are untrusted input, never SQL fragments. */
export function reviewFilters(value: unknown): SmsReviewFilters {
  const defaults = defaultReviewFilters();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
  const item = value as Record<string, unknown>;
  const choice = (key: 'state' | 'kind' | 'read', allowed: readonly string[]): string =>
    typeof item[key] === 'string' && allowed.includes(item[key]) ? item[key] : defaults[key];
  const text = (key: 'search' | 'source') =>
    typeof item[key] === 'string' && item[key].length <= 1000 ? item[key] : '';
  const date = (key: 'from' | 'to') => {
    const day = item[key];
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
    const parsed = new Date(`${day}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day
      ? day
      : '';
  };
  return {
    state: choice('state', [
      'ALL',
      'PENDING',
      'DEFERRED',
      'ERROR',
      'IMPORTED',
      'MATCHED_EXISTING',
      'REJECTED',
      'IGNORED',
    ]),
    kind: choice('kind', [
      'ALL',
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
    ]),
    search: text('search'),
    source: text('source'),
    from: date('from'),
    to: date('to'),
    read: choice('read', ['UNREAD', 'READ', 'ALL']),
    mode: item['mode'] === 'MULTIPLE' ? 'MULTIPLE' : 'SINGLE',
    kinds: Array.isArray(item['kinds'])
      ? [
          ...new Set(
            item['kinds']
              .slice(0, 100)
              .filter(
                (kind): kind is string =>
                  typeof kind === 'string' && (SMS_KINDS as readonly string[]).includes(kind),
              ),
          ),
        ]
      : [],
    multipleInitialized: item['multipleInitialized'] === true || item['mode'] === 'MULTIPLE',
  };
}
