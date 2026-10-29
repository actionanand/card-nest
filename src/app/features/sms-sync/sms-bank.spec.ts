import { CreditCard, PaymentSource, CardTransaction } from '../../core/models/domain';
import {
  SmsEvidence,
  accountSuffixMatches,
  bankDirection,
  bankExistingSuggestions,
  bankPurposes,
  bankSourceConflict,
  defaultBankCategory,
  defaultBankPurpose,
  eligibleSources,
  bankDisplayName,
  ledgerType,
  matchingBankAccounts,
  normalizedIssuer,
  suggestedBankSources,
  validEvidence,
} from './sms-model';

/** Fictional identifiers only. */
describe('Bank/UPI review model', () => {
  const on = { enabled: true, askCardSettlementFunding: true };
  const off = { enabled: false, askCardSettlementFunding: false };
  const evidence = (changes: Partial<SmsEvidence> = {}): SmsEvidence => ({
    id: 'b'.repeat(64),
    providerId: '7',
    parserVersion: 3,
    kind: 'BANK_DEBIT',
    direction: 'DEBIT',
    purposeHint: 'PURCHASE',
    amountMinor: 45000,
    currency: 'INR',
    eventDate: '2026-10-21',
    eventAt: '2026-10-20T18:30:00Z',
    receivedAt: 1792540800000,
    dateFallback: false,
    issuer: 'ICICI',
    accountDigits: '417',
    merchant: 'HILL FARM MEATS',
    reference: '735182094619',
    evidence: 'Synthetic',
    ...changes,
  });
  const account = (changes: Partial<PaymentSource>): PaymentSource => ({
    id: 'account',
    nickname: 'Account',
    kind: 'DEBIT',
    noLimit: true,
    autoLoad: false,
    archived: false,
    ...changes,
  });
  const sources = [
    account({ id: 'source-debit', nickname: 'Bank / UPI', institution: 'Primary bank' }),
    account({ id: 'icici', institution: 'ICICI Bank', lastDigits: '417' }),
    account({ id: 'other-bank', institution: 'Federal Bank', lastDigits: '417' }),
    account({ id: 'scb', institution: 'Standard Chartered', lastDigits: '6042' }),
  ];

  it('offers purchase review for a plain debit even with tracking off, never auto-ledgered', () => {
    const item = evidence();
    expect(ledgerType(item)).toBeUndefined();
    expect(bankPurposes(item, off)).toEqual(['PURCHASE']);
    expect(defaultBankPurpose(item, off)).toBe('PURCHASE');
    expect(bankPurposes(item, on)).toEqual(['PURCHASE', 'TRANSFER', 'CARD_SETTLEMENT']);
  });

  it('never defaults credits, transfers or repayments to spending', () => {
    const credit = evidence({ kind: 'BANK_CREDIT', direction: 'CREDIT', purposeHint: 'INCOMING' });
    expect(bankPurposes(credit, off)).toEqual(['INCOME']);
    expect(defaultBankPurpose(credit, on)).toBe('');
    const transfer = evidence({ kind: 'BANK_TRANSFER', purposeHint: 'ACCOUNT_TRANSFER' });
    expect(defaultBankPurpose(transfer, off)).toBe('');
    expect(bankPurposes(transfer, off)).toEqual(['PURCHASE']);
    const card = evidence({ purposeHint: 'CARD_REPAYMENT' });
    expect(bankPurposes(card, off)).toEqual([]);
    expect(bankPurposes(card, on)).not.toContain('PURCHASE');
    const loan = evidence({ kind: 'LOAN_DEBIT', purposeHint: 'LOAN_REPAYMENT' });
    expect(bankPurposes(loan, on)).toEqual(['LOAN_REPAYMENT']);
    expect(bankPurposes(evidence({ kind: 'BANK_TRANSFER', direction: undefined }), on)).toEqual([]);
    expect(bankDirection(evidence({ kind: 'BANK_CREDIT', direction: undefined }))).toBe('CREDIT');
  });

  it('matches accounts by suffix and bank, never by suffix alone across banks', () => {
    expect(accountSuffixMatches('417', '0417')).toBe(true);
    expect(accountSuffixMatches('6042', '56042')).toBe(true);
    expect(accountSuffixMatches('417', '418')).toBe(false);
    expect(matchingBankAccounts(evidence(), sources).map((source) => source.id)).toEqual(['icici']);
    expect(
      matchingBankAccounts(evidence({ issuer: undefined }), sources).map((source) => source.id),
    ).toEqual(['icici', 'other-bank']);
    expect(suggestedBankSources(evidence({ issuer: undefined }), sources, off)).toEqual([]);
    expect(suggestedBankSources(evidence(), sources, on)).toEqual(['icici']);
    expect(suggestedBankSources(evidence({ accountDigits: '999' }), sources, off)).toEqual([
      'source-debit',
    ]);
    expect(suggestedBankSources(evidence({ accountDigits: '999' }), sources, on)).toEqual([]);
    expect(bankSourceConflict(evidence({ accountDigits: '999' }), sources[1])).toContain('suffix');
    expect(bankSourceConflict(evidence(), sources[2])).toContain('bank differs');
    expect(bankSourceConflict(evidence(), sources[0])).toBe('');
  });
  it('uses suffix-only SMS suggestions for unrecognized bank names but preserves known-bank conflicts', () => {
    const unknownIssuer = evidence({ issuer: 'Unrecognized issuer' });
    expect(matchingBankAccounts(unknownIssuer, sources).map((source) => source.id)).toEqual([
      'icici',
      'other-bank',
    ]);
    expect(suggestedBankSources(unknownIssuer, sources, on)).toEqual([]);
    expect(bankSourceConflict(unknownIssuer, sources[2])).toBe('');
    expect(bankSourceConflict(evidence(), sources[2])).toContain('bank differs');
  });
  it('rejects shared-suffix suggestions for Yes Bank, IndusInd and explicit regional bank conflicts', () => {
    const hdfc = account({ id: 'hdfc', institution: 'HDFC Bank', lastDigits: '417' });
    const icici = account({ id: 'icici', institution: 'ICICI Bank', lastDigits: '417' });
    const yesAccount = account({ id: 'yes', institution: 'Yes Bank', lastDigits: '417' });
    const indusAccount = account({ id: 'indus', institution: 'IndusInd Bank', lastDigits: '417' });
    expect(normalizedIssuer('YES BANK')).toBe('yes');
    expect(bankDisplayName('yesbank')).toBe('Yes Bank');
    expect(matchingBankAccounts(evidence({ issuer: 'Yes Bank' }), [hdfc])).toEqual([]);
    expect(suggestedBankSources(evidence({ issuer: 'Yes Bank' }), [hdfc], on)).toEqual([]);
    expect(matchingBankAccounts(evidence({ issuer: 'IndusInd Bank' }), [icici])).toEqual([]);
    expect(suggestedBankSources(evidence({ issuer: 'IndusInd Bank' }), [icici], on)).toEqual([]);
    expect(matchingBankAccounts(evidence({ issuer: 'HDFC Bank' }), [yesAccount])).toEqual([]);
    expect(matchingBankAccounts(evidence({ issuer: 'Some Regional Bank' }), [icici])).toEqual([]);
    expect(
      matchingBankAccounts(evidence({ issuer: undefined }), [yesAccount, indusAccount]),
    ).toHaveLength(2);
  });
  it('does not auto-suggest an active SMS source when an archived account shares its suffix', () => {
    const active = account({ id: 'active', institution: 'ICICI Bank', lastDigits: '417' });
    const archived = account({
      id: 'archived',
      institution: 'Unrecognized issuer',
      lastDigits: '00417',
      archived: true,
    });
    const unknownIssuer = evidence({ issuer: undefined });
    expect(
      matchingBankAccounts(unknownIssuer, [active, archived]).map((source) => source.id),
    ).toEqual(['active']);
    expect(suggestedBankSources(unknownIssuer, [active, archived], on)).toEqual([]);
  });

  it('matches HSBC bank repayment and card-purchase evidence without defaulting repayment to spending', () => {
    const hsbcAccount = account({
      id: 'hsbc-2006',
      institution: 'HSBC Bank',
      lastDigits: '2006',
    });
    const repayment = evidence({
      kind: 'PAYMENT_INITIATED',
      issuer: 'HSBC',
      accountDigits: '2006',
      merchant: 'CRED Club',
      purposeHint: 'CARD_REPAYMENT',
      amountMinor: 652066,
    });
    expect(normalizedIssuer('HSBC Bank')).toBe('hsbc');
    expect(bankDisplayName('HSBC')).toBe('HSBC');
    expect(matchingBankAccounts(repayment, [hsbcAccount])).toEqual([hsbcAccount]);
    expect(suggestedBankSources(repayment, [hsbcAccount], on)).toEqual(['hsbc-2006']);
    expect(bankPurposes(repayment, off)).toEqual([]);
    expect(defaultBankPurpose(repayment, on)).toBe('');
    expect(bankPurposes(repayment, on)).toEqual(['CARD_SETTLEMENT']);

    const hsbcCard: CreditCard = {
      id: 'hsbc-card-0379',
      nickname: 'Synthetic HSBC card',
      issuerName: 'HSBC',
      lastDigits: '0379',
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
    };
    const purchase = evidence({
      kind: 'PURCHASE',
      issuer: 'HSBC',
      cardDigits: '0379',
      accountDigits: undefined,
      merchant: 'FLIPKART',
      amountMinor: 101800,
      purposeHint: undefined,
    });
    expect(eligibleSources(purchase, [hsbcCard], [])).toEqual([hsbcCard.id]);
  });

  it('suggests duplicates only without conflicting references and picks safe categories', () => {
    const manual: CardTransaction = {
      id: 'manual',
      cardId: 'icici',
      type: 'PURCHASE',
      amountMinor: 45000,
      currencyCode: 'INR',
      transactionDate: '2026-10-21',
      categoryId: 'other',
      attachmentIds: [],
      createdAt: 'now',
      updatedAt: 'now',
    };
    expect(bankExistingSuggestions(evidence(), 'PURCHASE', 'icici', [manual])).toEqual([manual]);
    expect(
      bankExistingSuggestions(evidence(), 'PURCHASE', 'icici', [
        { ...manual, reference: '735182099999' },
      ]),
    ).toEqual([]);
    expect(bankExistingSuggestions(evidence(), 'CREDIT', 'icici', [manual])).toEqual([]);
    const categories = [
      { id: 'meat-dairy', archived: false, appliesTo: 'BOTH' as const },
      { id: 'dining', archived: false, appliesTo: 'BOTH' as const },
      { id: 'income', archived: false, appliesTo: 'CREDIT' as const },
      { id: 'other', archived: false, appliesTo: 'BOTH' as const },
    ];
    expect(defaultBankCategory('PURCHASE', 'HILL FARM MEATS', categories)).toBe('meat-dairy');
    expect(defaultBankCategory('PURCHASE', 'COFFEE STALL', categories)).toBe('dining');
    expect(defaultBankCategory('PURCHASE', 'HOME RENT PORTAL', categories)).toBe('other');
    expect(defaultBankCategory('INCOME', 'JAMIE RIVERS', categories)).toBe('income');
    expect(() => defaultBankCategory('INCOME', undefined, [])).toThrow('Category integrity error');
  });

  it('validates bank evidence fields', () => {
    expect(validEvidence(evidence({ amountDueMinor: 1048666 }))).toBe(true);
    expect(validEvidence(evidence({ amountDueMinor: -1 }))).toBe(false);
    expect(validEvidence(evidence({ amountDueMinor: 104.5 }))).toBe(false);
    expect(validEvidence({ ...evidence(), direction: 'SIDEWAYS' })).toBe(false);
    expect(validEvidence({ ...evidence(), counterpartyAccountDigits: '12' })).toBe(false);
  });
});
