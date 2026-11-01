import { CardTransaction } from '../../core/models/domain';
import { SmsEvidence } from './sms-model';
import { continuousSmsSplit, SMS_SPLIT_GAP_MS, SmsSequenceAlert } from './sms-split-continuity';

describe('Strict financial SMS continuity (separate from duplicate matching)', () => {
  const start = Date.parse('2026-10-26T12:00:00Z');
  function alert(
    id: string,
    minutes: number,
    amount: number,
    changes: Partial<SmsEvidence> = {},
    row: Partial<SmsSequenceAlert> = {},
  ): SmsSequenceAlert {
    const receivedAt = start + minutes * 60000;
    const local = new Date(receivedAt - 60000 + 330 * 60000).toISOString();
    const item: SmsEvidence = {
      id,
      providerId: id,
      parserVersion: 3,
      kind: 'PURCHASE',
      amountMinor: amount,
      currency: 'INR',
      eventDate: local.slice(0, 10),
      eventTime: local.slice(11, 19),
      eventAt: new Date(receivedAt - 60000).toISOString(),
      eventTimeExplicit: true,
      receivedAt,
      dateFallback: false,
      merchant: 'Local Market',
      issuer: 'HSBC',
      cardDigits: '4844',
      reference: `REF-${id}`,
      evidence: 'Synthetic',
      ...changes,
    };
    return {
      id,
      kind: item.kind,
      item,
      receivedAt,
      state: 'PENDING',
      discoveryOrder: minutes + 1,
      ...row,
    };
  }
  const entry = (
    id: string,
    amount: number,
    source: string,
    splitGroupId?: string,
  ): CardTransaction => ({
    id,
    cardId: source,
    type: 'PURCHASE',
    amountMinor: amount,
    currencyCode: 'INR',
    transactionDate: '2026-10-26',
    merchant: 'Local Market',
    categoryId: 'other',
    attachmentIds: [],
    createdAt: 'before',
    updatedAt: 'before',
    splitGroupId,
  });
  const first = () => alert('a', 0, 20000, {}, { transactionId: 'first', state: 'IMPORTED' });
  it('suggests two consecutive distinct payments without creating any group', () => {
    const alerts = [first(), alert('b', 5, 2000)];
    const ledger = [entry('first', 20000, 'meal')];
    const before = structuredClone({ alerts, ledger });
    expect(continuousSmsSplit(alerts, 'b', 'upi', ledger)).toMatchObject({
      targetId: 'first',
      approximate: false,
    });
    expect({ alerts, ledger }).toEqual(before);
  });
  it('resolves a third and later consecutive payment to the same existing group', () => {
    const second = alert('b', 5, 2000, {}, { transactionId: 'second', state: 'IMPORTED' });
    const ledger = [
      entry('first', 20000, 'meal', 'stable-group'),
      entry('second', 2000, 'upi', 'stable-group'),
    ];
    expect(
      continuousSmsSplit([first(), second, alert('c', 10, 3000)], 'c', 'card', ledger)?.targetId,
    ).toBe('stable-group');
  });
  it('an unrelated financial payment breaks continuity despite a matching earlier merchant', () => {
    const second = alert('b', 5, 2000, {}, { transactionId: 'second', state: 'IMPORTED' });
    const fuel = alert(
      'fuel',
      8,
      100000,
      { merchant: 'Petrol Station' },
      { transactionId: 'fuel-entry', state: 'IMPORTED' },
    );
    const ledger = [
      entry('first', 20000, 'meal'),
      entry('second', 2000, 'upi'),
      entry('fuel-entry', 100000, 'fuel-card'),
    ];
    const sequence = [first(), second, fuel, alert('c', 10, 3000)];
    expect(
      continuousSmsSplit(
        [
          first(),
          { ...second, state: 'PENDING', transactionId: undefined },
          fuel,
          alert('c', 10, 3000),
        ],
        'b',
        'upi',
        ledger,
      ),
    ).not.toBeNull();
    expect(continuousSmsSplit(sequence, 'c', 'card', ledger)).toBeNull();
  });
  it('informational notices do not interrupt actual payment continuity; OTP/promotions are not financial candidates', () => {
    expect(
      continuousSmsSplit(
        [first(), alert('notice', 3, 500, { kind: 'STATEMENT' }), alert('b', 5, 2000)],
        'b',
        'upi',
        [entry('first', 20000, 'meal')],
      ),
    ).not.toBeNull();
  });
  it.each([30, 30.01, 60, 1080])(
    'enforces the independent 30-minute guard at %s minutes',
    (minutes) => {
      expect(SMS_SPLIT_GAP_MS).toBe(1800000);
      expect(
        continuousSmsSplit([first(), alert('b', minutes, 2000)], 'b', 'upi', [
          entry('first', 20000, 'meal'),
        ]) !== null,
      ).toBe(minutes <= 30);
    },
  );
  it('rejects different-day adjacency, delayed, contradictory and invalid times', () => {
    const ledger = [entry('first', 20000, 'meal')];
    expect(
      continuousSmsSplit(
        [first(), alert('b', 5, 2000, { eventDate: '2026-10-25' })],
        'b',
        'upi',
        ledger,
      ),
    ).toBeNull();
    expect(
      continuousSmsSplit(
        [first(), alert('b', 5, 2000, { eventAt: '2026-10-26T11:00:00Z', eventTime: '16:30:00' })],
        'b',
        'upi',
        ledger,
      ),
    ).toBeNull();
    expect(
      continuousSmsSplit(
        [first(), alert('b', 5, 2000, { eventAt: '2026-10-26T11:58:00Z', eventTime: '17:28:00' })],
        'b',
        'upi',
        ledger,
      ),
    ).toBeNull();
    expect(
      continuousSmsSplit(
        [first(), alert('b', 5, 2000, {}, { receivedAt: Number.NaN })],
        'b',
        'upi',
        ledger,
      ),
    ).toBeNull();
    expect(
      continuousSmsSplit(
        [
          first(),
          alert('unknown', 2, 500, {}, { receivedAt: null, discoveryOrder: 2 }),
          alert('b', 5, 2000, {}, { discoveryOrder: 3 }),
        ],
        'b',
        'upi',
        ledger,
      ),
    ).toBeNull();
  });
  it('deduplicates confirmations of the same financial event before checking adjacency', () => {
    const duplicate = alert(
      'confirmation',
      2,
      20000,
      { reference: 'REF-a' },
      { transactionId: 'first', state: 'MATCHED_EXISTING' },
    );
    expect(
      continuousSmsSplit([first(), duplicate, alert('b', 5, 2000)], 'b', 'upi', [
        entry('first', 20000, 'meal'),
      ]),
    ).not.toBeNull();
    expect(
      continuousSmsSplit([first(), duplicate], 'confirmation', 'upi', [
        entry('first', 20000, 'meal'),
      ]),
    ).toBeNull();
  });
  it('refuses equal references or ambiguous same-amount notifications and same-source payments', () => {
    const ledger = [entry('first', 20000, 'meal')];
    expect(
      continuousSmsSplit(
        [first(), alert('b', 5, 2000, { reference: 'REF-a' })],
        'b',
        'upi',
        ledger,
      ),
    ).toBeNull();
    expect(
      continuousSmsSplit(
        [first(), alert('b', 5, 20000, { reference: undefined })],
        'b',
        'upi',
        ledger,
      ),
    ).toBeNull();
    expect(continuousSmsSplit([first(), alert('b', 5, 2000)], 'b', 'meal', ledger)).toBeNull();
  });
  it('allows approximate receipt timing only with same-day continuity and an independently recorded predecessor', () => {
    const a = first();
    a.item = { ...a.item!, eventTimeExplicit: false };
    const b = alert('b', 5, 2000, { eventTimeExplicit: false });
    expect(continuousSmsSplit([a, b], 'b', 'upi', [entry('first', 20000, 'meal')])).toMatchObject({
      approximate: true,
    });
    expect(
      continuousSmsSplit([{ ...a, state: 'PENDING', transactionId: undefined }, b], 'b', 'upi', []),
    ).toBeNull();
  });
  it('reads receipt chronology rather than query order and does not infer continuity from merchant similarity alone', () => {
    const b = alert('b', 5, 2000);
    expect(
      continuousSmsSplit([b, first()], 'b', 'upi', [entry('first', 20000, 'meal')]),
    ).not.toBeNull();
    expect(
      continuousSmsSplit([first(), alert('b', 5, 2000, { merchant: 'Fuel Station' })], 'b', 'upi', [
        entry('first', 20000, 'meal'),
      ]),
    ).toBeNull();
  });
});
