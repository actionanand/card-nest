import { CardTransaction } from '../../core/models/domain';
import { SmsEvidence, bankExistingSuggestions, existingSuggestions } from './sms-model';
import {
  PURCHASE_WINDOW_MS,
  purchaseAnchor,
  purchaseCompatible,
  purchaseTiming,
  purchaseTimestamp,
} from './sms-purchase-matching';

describe('Shared 18-hour purchase comparison', () => {
  const sms: SmsEvidence = {
    id: 'a'.repeat(64),
    providerId: 'synthetic',
    parserVersion: 3,
    kind: 'PURCHASE',
    amountMinor: 5000,
    currency: 'INR',
    eventDate: '2026-10-26',
    eventAt: '2026-10-26T12:00:00Z',
    eventTime: '17:30:00',
    eventTimeExplicit: true,
    receivedAt: Date.parse('2026-10-26T12:05:00Z'),
    dateFallback: false,
    evidence: 'Synthetic',
    cardDigits: '4844',
    merchant: 'Daily milk',
  };
  const entry: CardTransaction = {
    id: 'earlier',
    cardId: 'card',
    type: 'PURCHASE',
    amountMinor: 5000,
    currencyCode: 'INR',
    transactionDate: '2026-10-26',
    transactionTime: '17:00',
    merchant: 'Daily milk',
    categoryId: 'groceries',
    attachmentIds: [],
    createdAt: 'before',
    updatedAt: 'before',
  };
  it.each([30, 360, 1019, 1079, 1080, 1081, 1440, 4320])(
    'compares %i minutes inclusively without calendar-day rounding',
    (minutes) => {
      const local = new Date(Date.parse(sms.eventAt) - minutes * 60000 + 330 * 60000).toISOString();
      const earlier = {
        ...entry,
        transactionDate: local.slice(0, 10),
        transactionTime: local.slice(11, 19),
      };
      for (const item of [
        sms,
        { ...sms, eventTimeExplicit: false, receivedAt: Date.parse(sms.eventAt) },
      ]) {
        expect(purchaseCompatible(item, earlier, 'card')).toBe(
          minutes * 60000 <= PURCHASE_WINDOW_MS,
        );
        expect(existingSuggestions(item, 'card', [earlier]).length).toBe(minutes <= 1080 ? 1 : 0);
        expect(
          bankExistingSuggestions(
            { ...item, kind: 'BANK_DEBIT', direction: 'DEBIT', purposeHint: 'PURCHASE' },
            'PURCHASE',
            'card',
            [earlier],
          ).length,
        ).toBe(minutes <= 1080 ? 1 : 0);
      }
    },
  );
  it('does not warn about ₹113 on October 23 versus October 26 or daily ₹50 purchases 24 hours apart', () => {
    expect(
      existingSuggestions({ ...sms, amountMinor: 11300 }, 'card', [
        { ...entry, amountMinor: 11300, transactionDate: '2026-10-23' },
      ]),
    ).toEqual([]);
    expect(
      existingSuggestions(sms, 'card', [
        { ...entry, transactionDate: '2026-10-25', transactionTime: '17:30' },
      ]),
    ).toEqual([]);
  });
  it('uses Indian local times across midnight, including a UTC-date boundary', () => {
    const overnight = { ...sms, eventAt: '2026-10-25T19:30:00Z', eventTime: '01:00:00' };
    expect(
      purchaseTiming(overnight, {
        ...entry,
        transactionDate: '2026-10-25',
        transactionTime: '23:30',
      })?.differenceMs,
    ).toBe(90 * 60000);
    expect(purchaseTimestamp('2026-10-26', '01:00')).toBe(Date.parse('2026-10-25T19:30:00Z'));
  });
  it('uses receipt only as a labelled approximation and preserves the original event date', () => {
    const undatedTime = { ...sms, eventTimeExplicit: false, eventAt: '2026-10-25T18:30:00Z' };
    expect(purchaseAnchor(undatedTime)).toMatchObject({
      kind: 'SMS_RECEIVED_FALLBACK',
      timestamp: sms.receivedAt,
      originalEventDate: '2026-10-26',
    });
    expect(purchaseTiming(undatedTime, entry)?.reason).toContain('approximate');
    expect(purchaseAnchor({ ...sms, eventTime: '00:00' }).kind).toBe('SMS_RECEIVED_FALLBACK');
    expect(
      purchaseAnchor({ ...sms, receivedAt: Number.NaN, eventTimeExplicit: false }).timestamp,
    ).toBeNull();
  });
  it('does not confuse a delayed SMS with a new purchase on its receipt day', () => {
    const delayed = { ...sms, eventTimeExplicit: false, eventDate: '2026-10-23' };
    expect(purchaseAnchor(delayed).delayed).toBe(true);
    expect(purchaseTiming(delayed, entry)).toBeNull();
    expect(
      purchaseTiming(delayed, {
        ...entry,
        transactionDate: '2026-10-23',
        transactionTime: undefined,
      })?.differenceMs,
    ).toBeNull();
  });
  it('preserves verified reference identity separately from proximity for a delayed SMS', () => {
    const delayed = {
      ...sms,
      eventTimeExplicit: false,
      eventDate: '2026-10-23',
      reference: 'VERIFIED_REF',
    };
    const earlier = { ...entry, transactionDate: '2026-10-23', reference: 'VERIFIED_REF' };
    expect(purchaseTiming(delayed, earlier)).toBeNull();
    expect(purchaseCompatible(delayed, earlier, 'card')).toBe(true);
    expect(purchaseCompatible({ ...delayed, reference: undefined }, earlier, 'card')).toBe(false);
  });
  it('keeps date-only comparisons on the original local date, never midnight or an adjacent day', () => {
    const dateOnly = { ...entry, transactionTime: undefined };
    expect(purchaseTiming(sms, dateOnly)).toMatchObject({ differenceMs: null });
    expect(purchaseTiming(sms, { ...dateOnly, transactionDate: '2026-10-25' })).toBeNull();
    expect(purchaseTiming(sms, { ...dateOnly, transactionDate: '2026-10-27' })).toBeNull();
  });
  it('requires source, currency, type, amount and compatible references but permits different merchants', () => {
    for (const changed of [
      { cardId: 'another-card' },
      { currencyCode: 'USD' },
      { type: 'PAYMENT' as const },
      { amountMinor: 5100 },
      { reference: 'DIFFERENT' },
    ])
      expect(
        purchaseCompatible({ ...sms, reference: 'VERIFIED' }, { ...entry, ...changed }, 'card'),
      ).toBe(false);
    expect(purchaseCompatible(sms, { ...entry, merchant: 'Breakfast' }, 'card')).toBe(true);
  });
  it('recognizes an explicitly classified split payment as the same purchase purpose without matching legacy or balance corrections', () => {
    expect(
      purchaseCompatible(
        sms,
        { ...entry, type: 'ADJUSTMENT', adjustmentPurpose: 'SPLIT_PAYMENT' },
        'card',
      ),
    ).toBe(true);
    expect(
      purchaseCompatible(
        sms,
        { ...entry, type: 'ADJUSTMENT', adjustmentPurpose: 'LEGACY_MANUAL' },
        'card',
      ),
    ).toBe(false);
    expect(
      purchaseCompatible(
        sms,
        { ...entry, type: 'ADJUSTMENT', adjustmentPurpose: 'BALANCE_RECONCILIATION' },
        'card',
      ),
    ).toBe(false);
  });
  it('edits refresh suggestions without inventing a timestamp on the edited date', () => {
    expect(purchaseAnchor(sms, '2026-10-25')).toMatchObject({
      kind: 'REVIEW_DATE_ONLY',
      timestamp: null,
    });
    expect(existingSuggestions(sms, 'card', [entry], 5100)).toEqual([]);
    expect(existingSuggestions(sms, 'card', [entry], 5000, '2026-10-25')).toEqual([]);
    expect(purchaseTimestamp('2026-02-31', '12:00')).toBeNull();
    expect(purchaseTimestamp('2026-10-26', '25:00')).toBeNull();
  });
});
