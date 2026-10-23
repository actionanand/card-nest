import { CreditCard, PaymentSource } from '../../core/models/domain';
import {
  SmsEvidence,
  eligibleSources,
  merchantTitle,
  recurringRelationship,
  ledgerType,
} from './sms-model';

const card = (changes: Partial<CreditCard> = {}): CreditCard => ({
  id: 'synthetic-card',
  nickname: 'Demo',
  issuerName: 'HDFC Bank',
  lastDigits: '4321',
  network: 'VISA',
  theme: 'green',
  statementDay: 1,
  dueDateMode: 'DAYS_AFTER_STATEMENT',
  daysAfterStatement: 20,
  adjustDueDateOnWeekend: false,
  currencyCode: 'INR',
  openingBalanceMinor: 0,
  remindToSettle: false,
  annualFeeEnabled: false,
  emergencyPhones: [],
  supportEmails: [],
  archived: false,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  ...changes,
});
const item = (changes: Partial<SmsEvidence> = {}): SmsEvidence => ({
  id: 'a'.repeat(64),
  providerId: 'demo',
  parserVersion: 3,
  kind: 'PURCHASE',
  amountMinor: 10000,
  currency: 'INR',
  eventDate: '2026-10-18',
  eventAt: '2026-10-18T12:00:00Z',
  receivedAt: 1,
  dateFallback: false,
  evidence: 'Synthetic',
  cardDigits: '4321',
  ...changes,
});
const mealWallet = (changes: Partial<PaymentSource> = {}): PaymentSource => ({
  id: 'meal-wallet',
  nickname: 'Pluxee meal card',
  institution: 'Pluxee',
  kind: 'MEAL',
  lastDigits: '8765',
  noLimit: false,
  balanceMinor: 10000,
  autoLoad: false,
  archived: false,
  ...changes,
});
describe('Reliable SMS source matching', () => {
  it.each(['VISA', 'MASTERCARD', 'RUPAY'] as const)(
    'matches a card-specific suffix with missing issuer for %s',
    (network) => {
      expect(eligibleSources(item(), [card({ network })], [])).toEqual(['synthetic-card']);
    },
  );
  it.each([
    ['American Express', 'AMEX'],
    ['Standard Chartered Bank', 'STANCHART'],
    ['Bank of Baroda', 'BOBCARD'],
    ['State Bank of India', 'SBI Card'],
    ['IDFC First Bank', 'IDFC'],
    ['AU Small Finance Bank', 'AU Bank'],
    ['HDFC Bank Ltd', 'HDFC'],
  ])('normalizes %s and %s', (saved, detected) => {
    expect(
      eligibleSources(item({ issuer: detected }), [card({ issuerName: saved })], []),
    ).toHaveLength(1);
  });
  it.each(['4321', '54321'])('supports AMEX suffix %s', (cardDigits) => {
    expect(
      eligibleSources(
        item({ cardDigits, issuer: 'American Express' }),
        [card({ issuerName: 'AMEX', network: 'AMERICAN_EXPRESS', lastDigits: '54321' })],
        [],
      ),
    ).toHaveLength(1);
  });
  it('keeps same-suffix collisions ambiguous and uses explicit issuer to disambiguate', () => {
    const cards = [card(), card({ id: 'second', issuerName: 'Axis Bank' })];
    expect(eligibleSources(item(), cards, [])).toHaveLength(2);
    expect(eligibleSources(item({ issuer: 'Axis' }), cards, [])).toEqual(['second']);
    expect(eligibleSources(item({ issuer: 'ICICI' }), cards, [])).toEqual([]);
  });
  it('never substitutes account, reference, phone or issuer-only evidence for card digits', () => {
    for (const suffix of [undefined, '', '123', '9000000000', '123456', 'XX4321'])
      expect(
        eligibleSources(
          item({ cardDigits: suffix, accountDigits: '4321', reference: '4321', issuer: 'HDFC' }),
          [card()],
          [],
        ),
      ).toEqual([]);
  });
  it('excludes deleted, malformed and foreign currency cards', () => {
    for (const changes of [
      { deletedAt: '2026-01-01' },
      { lastDigits: '54321' },
      { currencyCode: 'USD' },
    ])
      expect(eligibleSources(item(), [card(changes)], [])).toEqual([]);
  });
  it('only suggests archived cards for a dated historical event before archival', () => {
    expect(
      eligibleSources(item(), [card({ archived: true, archivedAt: '2026-10-19T00:00:00Z' })], []),
    ).toHaveLength(1);
    expect(eligibleSources(item(), [card({ archived: true })], [])).toEqual([]);
    expect(
      eligibleSources(item(), [card({ archived: true, archivedAt: '2026-10-01' })], []),
    ).toEqual([]);
  });
  it('groups scheduled and confirmed evidence only within the same source and explicit cycle', () => {
    const scheduled = item({
      kind: 'SCHEDULED_CHARGE',
      merchant: 'Synthetic Insurance',
      issuer: 'AMEX',
      standingInstructionReference: 'SYNTHSI12345',
    });
    const confirmed = item({
      id: 'b'.repeat(64),
      merchant: 'Synthetic Insurance',
      issuer: 'AMEX',
      standingInstructionReference: 'SYNTHSI12345',
    });
    expect(ledgerType(scheduled)).toBeUndefined();
    expect(recurringRelationship(scheduled, confirmed)).toBe(true);
    expect(recurringRelationship(scheduled, { ...confirmed, eventDate: '2026-07-18' })).toBe(false);
    expect(recurringRelationship(scheduled, { ...confirmed, cardDigits: '9876' })).toBe(false);
    expect(
      recurringRelationship(scheduled, { ...confirmed, standingInstructionReference: 'OTHERREF' }),
    ).toBe(false);
    expect(merchantTitle({ ...confirmed, merchant: 'T&Cs Apply' }, 'PURCHASE')).toBe(
      'Card purchase',
    );
    for (const parserVersion of [undefined, 2, Number.NaN, Number.POSITIVE_INFINITY])
      expect(ledgerType({ ...confirmed, parserVersion })).toBeUndefined();
  });
  it('does not guess a meal wallet from its kind alone', () => {
    expect(
      eligibleSources(
        item({ kind: 'PLUXEE_PURCHASE', cardDigits: undefined }),
        [],
        [
          {
            id: 'meal',
            nickname: 'Demo',
            kind: 'MEAL',
            archived: false,
            noLimit: false,
            autoLoad: false,
          },
        ],
      ),
    ).toEqual([]);
  });
  it('selects the sole active Pluxee/Sodexo wallet without a card suffix', () => {
    expect(
      eligibleSources(
        item({ kind: 'PLUXEE_PURCHASE', cardDigits: undefined }),
        [],
        [mealWallet({ institution: 'Sodexo' })],
      ),
    ).toEqual(['meal-wallet']);
    expect(
      eligibleSources(
        item({ kind: 'PLUXEE_PURCHASE', cardDigits: undefined }),
        [],
        [mealWallet(), mealWallet({ id: 'second' })],
      ),
    ).toEqual([]);
  });
  it('requires provider identity and never ignores a conflicting suffix or archived source', () => {
    const evidence = item({ kind: 'PLUXEE_PURCHASE', issuer: 'Pluxee', cardDigits: '8765' });
    expect(eligibleSources(evidence, [], [mealWallet()])).toEqual(['meal-wallet']);
    expect(eligibleSources({ ...evidence, cardDigits: '0000' }, [], [mealWallet()])).toEqual([]);
    expect(
      eligibleSources(
        { ...evidence, cardDigits: undefined },
        [],
        [mealWallet({ nickname: 'Unrelated meal account', institution: undefined })],
      ),
    ).toEqual([]);
    expect(
      eligibleSources({ ...evidence, cardDigits: undefined }, [], [mealWallet({ archived: true })]),
    ).toEqual([]);
  });
});
describe('Safe SMS list titles', () => {
  it.each([
    'https://example.invalid/ref/DEMO',
    'example.invalid/path',
    '12345678901234567890',
    'Ref SYNTHREF123456',
    'Call 9000000000',
  ])('falls back for %s', (merchant) => {
    expect(merchantTitle(item({ merchant }), 'PURCHASE')).toBe('Card purchase');
  });
  it('keeps a merchant while removing reference trailers and a leading terminal identifier', () => {
    expect(
      merchantTitle(item({ merchant: '123456789012 DEMO STORE Ref SYNTHREF123456' }), 'PURCHASE'),
    ).toBe('DEMO STORE');
    expect(merchantTitle(item({ merchant: 'merchant.one@sampleupi' }), 'PURCHASE')).toBe(
      'merchant.one@sampleupi',
    );
    expect(merchantTitle(null, 'STATEMENT')).toBe('Credit card statement');
    expect(merchantTitle(null, 'CARD_PAYMENT_RECEIVED')).toBe('Payment received');
  });
});
