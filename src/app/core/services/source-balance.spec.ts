import { CardTransaction, PaymentSource, SourceTransfer } from '../models/domain';
import { indiaTodayIso } from './india-date';
import { calculateNetSpending } from './money';
import {
  applyBankCashTransaction,
  applyTransferEffects,
  applyWalletTransaction,
  assetEffect,
  bankCashTracked,
  baselinePosition,
  CORRECTION_QUESTION,
  liquidTotals,
  needsBaselineConfirmation,
  parseBankCashTracking,
  reverseBalanceEffect,
  reverseTransferEffects,
  TIMING_QUESTION,
  transferKindFor,
} from './source-balance';

/** Fictional amounts in paise; no real account data. */
describe('Bank/Cash asset accounting', () => {
  const on = { enabled: true, askCardSettlementFunding: false };
  const off = { enabled: false, askCardSettlementFunding: false };
  const baseline = new Date(Date.now() - 60_000).toISOString();
  const today = indiaTodayIso();
  const sources = (): PaymentSource[] => [
    {
      id: 'bank',
      nickname: 'Fictional bank',
      kind: 'DEBIT',
      institution: 'ICICI Bank',
      lastDigits: '417',
      noLimit: true,
      balanceMinor: 1_000_000,
      balanceCutoverAt: baseline,
      autoLoad: false,
      archived: false,
    },
    {
      id: 'cash',
      nickname: 'Cash',
      kind: 'CASH',
      noLimit: true,
      balanceMinor: 20_000,
      balanceCutoverAt: baseline,
      autoLoad: false,
      archived: false,
    },
    {
      id: 'unknown',
      nickname: 'Unset bank',
      kind: 'DEBIT',
      noLimit: true,
      autoLoad: false,
      archived: false,
    },
  ];
  const entry = (changes: Partial<CardTransaction> = {}): CardTransaction => ({
    id: 'entry',
    cardId: 'bank',
    type: 'PURCHASE',
    amountMinor: 45_000,
    currencyCode: 'INR',
    transactionDate: today,
    categoryId: 'groceries',
    attachmentIds: [],
    // Same-day, untimed fixtures: the user confirmed they happened after the balance.
    balanceTiming: 'AFTER_BASELINE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...changes,
  });
  const transfer = (changes: Partial<SourceTransfer> = {}): SourceTransfer => ({
    id: 'transfer',
    kind: 'CASH_WITHDRAWAL',
    fromSourceId: 'bank',
    toSourceId: 'cash',
    amountMinor: 200_000,
    currencyCode: 'INR',
    transferDate: today,
    origin: 'MANUAL',
    balanceTiming: 'AFTER_BASELINE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...changes,
  });
  const balance = (list: PaymentSource[], id: string) =>
    list.find((source) => source.id === id)?.balanceMinor;

  it('uses asset semantics: purchases reduce, receipts increase and card payments never add funds', () => {
    expect(assetEffect(entry())).toBe(-45_000);
    expect(assetEffect(entry({ type: 'CREDIT' }))).toBe(45_000);
    expect(assetEffect(entry({ type: 'PAYMENT' }))).toBe(0);
  });

  it('applies a purchase and receipt exactly once and reverses an edit symmetrically', () => {
    const list = sources();
    const purchase = applyBankCashTransaction(list, null, entry(), on, new Date().toISOString());
    expect(balance(list, 'bank')).toBe(955_000);
    reverseBalanceEffect(list, purchase.balanceEffect, on);
    const edited = applyBankCashTransaction(
      list,
      purchase,
      { ...purchase, amountMinor: 50_000 },
      on,
      new Date().toISOString(),
    );
    expect(balance(list, 'bank')).toBe(950_000);
    reverseBalanceEffect(list, edited.balanceEffect, on);
    expect(balance(list, 'bank')).toBe(1_000_000);
    const receipt = applyBankCashTransaction(
      list,
      null,
      entry({ id: 'cash-in', cardId: 'cash', type: 'CREDIT', amountMinor: 50_000 }),
      on,
      new Date().toISOString(),
    );
    expect(receipt.balanceEffect?.deltaMinor).toBe(50_000);
    expect(balance(list, 'cash')).toBe(70_000);
  });

  it('never replays older or untracked entries, and tracking off changes nothing', () => {
    const list = sources();
    const older = applyBankCashTransaction(
      list,
      null,
      entry({ transactionDate: '2020-01-01' }),
      on,
      new Date().toISOString(),
    );
    expect(older.balanceEffect).toBeUndefined();
    expect(
      applyBankCashTransaction(list, null, entry({ cardId: 'unknown' }), on, baseline)
        .balanceEffect,
    ).toBeUndefined();
    const offEntry = applyBankCashTransaction(list, null, entry(), off, new Date().toISOString());
    expect(offEntry.balanceEffect).toBeUndefined();
    expect(balance(list, 'bank')).toBe(1_000_000);
    // A pre-existing entry without a recorded effect stays out of the confirmed balance when edited.
    const legacy = entry({ createdAt: '2020-01-01T00:00:00Z' });
    applyBankCashTransaction(
      list,
      legacy,
      { ...legacy, amountMinor: 1 },
      on,
      new Date().toISOString(),
    );
    expect(balance(list, 'bank')).toBe(1_000_000);
    expect(calculateNetSpending([entry(), entry({ id: 'cash-buy', cardId: 'cash' })])).toBe(90_000);
  });

  it('a rebase after re-enabling keeps earlier effects inside the new baseline', () => {
    const list = sources();
    const applied = applyBankCashTransaction(list, null, entry(), on, new Date().toISOString());
    const rebased = list.map((source) =>
      source.id === 'bank'
        ? {
            ...source,
            balanceMinor: 900_000,
            balanceCutoverAt: new Date(Date.now() + 1000).toISOString(),
          }
        : source,
    );
    reverseBalanceEffect(rebased, applied.balanceEffect, on);
    expect(balance(rebased, 'bank')).toBe(900_000);
  });

  it('conserves Bank + Cash for withdrawals, deposits, edits and deletes', () => {
    const list = sources();
    const now = new Date().toISOString();
    const total = () => (balance(list, 'bank') ?? 0) + (balance(list, 'cash') ?? 0);
    const before = total();
    const withdrawal = applyTransferEffects(list, null, transfer(), on, now);
    expect(balance(list, 'bank')).toBe(800_000);
    expect(balance(list, 'cash')).toBe(220_000);
    expect(total()).toBe(before);
    const deposit = applyTransferEffects(
      list,
      null,
      transfer({
        id: 'deposit',
        kind: 'CASH_DEPOSIT',
        fromSourceId: 'cash',
        toSourceId: 'bank',
        amountMinor: 50_000,
      }),
      on,
      now,
    );
    expect(balance(list, 'bank')).toBe(850_000);
    expect(balance(list, 'cash')).toBe(170_000);
    reverseTransferEffects(list, withdrawal, on);
    const edited = applyTransferEffects(
      list,
      withdrawal,
      { ...withdrawal, amountMinor: 100_000 },
      on,
      now,
    );
    expect(balance(list, 'bank')).toBe(950_000);
    expect(balance(list, 'cash')).toBe(70_000);
    reverseTransferEffects(list, edited, on);
    reverseTransferEffects(list, deposit, on);
    expect(balance(list, 'bank')).toBe(1_000_000);
    expect(balance(list, 'cash')).toBe(20_000);
    expect(total()).toBe(before);
  });

  it('refuses identical, untracked or tracking-off transfers rather than posting one side', () => {
    const now = new Date().toISOString();
    expect(() =>
      applyTransferEffects(sources(), null, transfer({ toSourceId: 'bank' }), on, now),
    ).toThrow('different');
    expect(() =>
      applyTransferEffects(sources(), null, transfer({ toSourceId: 'unknown' }), on, now),
    ).toThrow('current balance');
    expect(() => applyTransferEffects(sources(), null, transfer(), off, now)).toThrow('Turn on');
    expect(transferKindFor(sources()[0], sources()[1])).toBe('CASH_WITHDRAWAL');
    expect(transferKindFor(sources()[1], sources()[0])).toBe('CASH_DEPOSIT');
    expect(transferKindFor(sources()[0], sources()[2])).toBe('TRANSFER');
  });

  it('keeps Pluxee/FASTag semantics out of Bank/Cash and totals Bank and Cash separately', () => {
    const list: PaymentSource[] = [
      ...sources(),
      {
        id: 'meal',
        nickname: 'Pluxee',
        kind: 'MEAL',
        noLimit: false,
        balanceMinor: 5_000,
        autoLoad: false,
        archived: false,
      },
    ];
    applyWalletTransaction(list, entry({ cardId: 'bank' }), 1);
    expect(balance(list, 'bank')).toBe(1_000_000);
    applyWalletTransaction(list, entry({ cardId: 'meal', amountMinor: 1_000 }), 1);
    expect(balance(list, 'meal')).toBe(4_000);
    expect(liquidTotals(list, on)).toEqual({ bankMinor: 1_000_000, cashMinor: 20_000 });
    expect(liquidTotals(list, off)).toEqual({ bankMinor: null, cashMinor: null });
    expect(bankCashTracked(list[2], on)).toBe(false);
  });

  describe('same-day ordering against a confirmed balance (12:00 IST on 2026-03-10)', () => {
    const cutover = '2026-03-10T06:30:00.000Z';
    const now = '2026-04-01T00:00:00.000Z';
    const fixed = (): PaymentSource[] =>
      sources().map((source) =>
        source.balanceCutoverAt ? { ...source, balanceCutoverAt: cutover } : source,
      );
    const sameDay = (changes: Partial<CardTransaction> = {}) =>
      entry({ transactionDate: '2026-03-10', balanceTiming: undefined, ...changes });

    it('orders events by explicit India time and treats date-only events as uncertain', () => {
      expect(baselinePosition(cutover, '2026-03-09')).toBe('BEFORE');
      expect(baselinePosition(cutover, '2026-03-11')).toBe('AFTER');
      expect(baselinePosition(cutover, '2026-03-10')).toBe('UNCERTAIN');
      expect(baselinePosition(cutover, '2026-03-10', '11:59')).toBe('BEFORE');
      expect(baselinePosition(cutover, '2026-03-10', '12:00:00')).toBe('UNCERTAIN');
      expect(baselinePosition(cutover, '2026-03-10', '12:01')).toBe('AFTER');
      const bank = fixed()[0];
      expect(needsBaselineConfirmation(bank, on, '2026-03-10')).toBe(true);
      expect(needsBaselineConfirmation(bank, on, '2026-03-10', '13:00')).toBe(false);
      expect(needsBaselineConfirmation(bank, off, '2026-03-10')).toBe(false);
      expect(needsBaselineConfirmation(fixed()[2], on, '2026-03-10')).toBe(false);
    });

    it('never assumes an untimed same-day purchase or credit is after the balance', () => {
      const list = fixed();
      for (const type of ['PURCHASE', 'CREDIT'] as const) {
        expect(
          applyBankCashTransaction(list, null, sameDay({ type }), on, now).balanceEffect,
        ).toBeUndefined();
        expect(
          applyBankCashTransaction(
            list,
            null,
            sameDay({ type, balanceTiming: 'INCLUDED_IN_BASELINE' }),
            on,
            now,
          ).balanceEffect,
        ).toBeUndefined();
        expect(
          applyBankCashTransaction(list, null, sameDay({ type, transactionTime: '09:15' }), on, now)
            .balanceEffect,
        ).toBeUndefined();
      }
      expect(balance(list, 'bank')).toBe(1_000_000);
      const timed = applyBankCashTransaction(
        list,
        null,
        sameDay({ transactionTime: '18:30' }),
        on,
        now,
      );
      expect(timed.balanceEffect?.deltaMinor).toBe(-45_000);
      const confirmed = applyBankCashTransaction(
        list,
        null,
        sameDay({ id: 'cash-in', cardId: 'cash', type: 'CREDIT', balanceTiming: 'AFTER_BASELINE' }),
        on,
        now,
      );
      expect(confirmed.balanceEffect?.deltaMinor).toBe(45_000);
      expect([balance(list, 'bank'), balance(list, 'cash')]).toEqual([955_000, 65_000]);
    });

    it('editing keeps a valid effect, drops it when moved before the balance and adds it only on confirmation', () => {
      const list = fixed();
      const applied = applyBankCashTransaction(
        list,
        null,
        sameDay({ transactionTime: '18:30' }),
        on,
        now,
      );
      reverseBalanceEffect(list, applied.balanceEffect, on);
      const renamed = applyBankCashTransaction(list, applied, { ...applied, notes: 'x' }, on, now);
      expect(renamed.balanceEffect).toEqual(applied.balanceEffect);
      reverseBalanceEffect(list, renamed.balanceEffect, on);
      const movedEarlier = applyBankCashTransaction(
        list,
        renamed,
        { ...renamed, transactionTime: '08:00' },
        on,
        now,
      );
      expect(movedEarlier.balanceEffect).toBeUndefined();
      expect(balance(list, 'bank')).toBe(1_000_000);
      const untimed = applyBankCashTransaction(list, null, sameDay({ id: 'untimed' }), on, now);
      expect(untimed.balanceEffect).toBeUndefined();
      const answered = applyBankCashTransaction(
        list,
        untimed,
        { ...untimed, balanceTiming: 'AFTER_BASELINE' },
        on,
        now,
      );
      expect(answered.balanceEffect?.deltaMinor).toBe(-45_000);
      reverseBalanceEffect(list, answered.balanceEffect, on);
      expect(balance(list, 'bank')).toBe(1_000_000);
    });

    it('asks for the timing of an untimed same-day transfer instead of guessing', () => {
      const list = fixed();
      expect(() =>
        applyTransferEffects(
          list,
          null,
          transfer({ transferDate: '2026-03-10', balanceTiming: undefined }),
          on,
          now,
        ),
      ).toThrow(TIMING_QUESTION);
      const included = applyTransferEffects(
        list,
        null,
        transfer({ transferDate: '2026-03-10', balanceTiming: 'INCLUDED_IN_BASELINE' }),
        on,
        now,
      );
      expect(included.effects).toEqual([]);
      const earlier = applyTransferEffects(
        list,
        null,
        transfer({ transferDate: '2026-03-10', transferTime: '10:00', balanceTiming: undefined }),
        on,
        now,
      );
      expect(earlier.effects).toEqual([]);
      expect([balance(list, 'bank'), balance(list, 'cash')]).toEqual([1_000_000, 20_000]);
    });
  });

  describe('transfers across different confirmed balances', () => {
    // Bank confirmed 2026-03-01 12:00 IST; Cash confirmed later, 2026-03-10 12:00 IST.
    const mismatched = (): PaymentSource[] =>
      sources().map((source) =>
        source.id === 'bank'
          ? { ...source, balanceCutoverAt: '2026-03-01T06:30:00.000Z' }
          : source.id === 'cash'
            ? { ...source, balanceCutoverAt: '2026-03-10T06:30:00.000Z' }
            : source,
      );
    const now = '2026-04-01T00:00:00.000Z';
    const cases = [
      { name: 'Bank -> Cash', fromSourceId: 'bank', toSourceId: 'cash' },
      { name: 'Cash -> Bank', fromSourceId: 'cash', toSourceId: 'bank' },
    ] as const;

    for (const { name, fromSourceId, toSourceId } of cases) {
      it(`${name}: posts both sides or none, never one`, () => {
        const list = mismatched();
        const move = (changes: Partial<SourceTransfer>) =>
          transfer({
            fromSourceId,
            toSourceId,
            amountMinor: 10_000,
            balanceTiming: undefined,
            ...changes,
          });
        expect(() =>
          applyTransferEffects(list, null, move({ transferDate: '2026-03-05' }), on, now),
        ).toThrow('change only one account');
        expect(() =>
          applyTransferEffects(
            list,
            null,
            move({ transferDate: '2026-03-10', transferTime: '11:00' }),
            on,
            now,
          ),
        ).toThrow('change only one account');
        expect([balance(list, 'bank'), balance(list, 'cash')]).toEqual([1_000_000, 20_000]);
        const before = applyTransferEffects(
          list,
          null,
          move({ transferDate: '2026-02-20' }),
          on,
          now,
        );
        expect(before.effects).toEqual([]);
        const after = applyTransferEffects(
          list,
          null,
          move({ id: 'after', transferDate: '2026-03-12' }),
          on,
          now,
        );
        expect(after.effects).toHaveLength(2);
        const total = (balance(list, 'bank') ?? 0) + (balance(list, 'cash') ?? 0);
        expect(total).toBe(1_020_000);
        // Moving it between the two balances is rejected; the caller rolls back.
        const rollback = structuredClone(list);
        reverseTransferEffects(list, after, on);
        expect(() =>
          applyTransferEffects(list, after, { ...after, transferDate: '2026-03-05' }, on, now),
        ).toThrow('change only one account');
        // An unchanged edit restores exactly the prior effects.
        reverseTransferEffects(rollback, after, on);
        const restored = applyTransferEffects(
          rollback,
          after,
          { ...after, description: 'x' },
          on,
          now,
        );
        expect(restored.effects).toEqual(after.effects);
        reverseTransferEffects(rollback, restored, on);
        expect([balance(rollback, 'bank'), balance(rollback, 'cash')]).toEqual([1_000_000, 20_000]);
      });
    }

    it('Bank -> Bank with different balances follows the same rule; one-sided card funding still posts', () => {
      const list: PaymentSource[] = [
        ...mismatched(),
        {
          id: 'bank-2',
          nickname: 'Second fictional bank',
          kind: 'DEBIT',
          institution: 'Slice',
          lastDigits: '7316',
          noLimit: true,
          balanceMinor: 300_000,
          balanceCutoverAt: '2026-03-10T06:30:00.000Z',
          autoLoad: false,
          archived: false,
        },
      ];
      const move = (changes: Partial<SourceTransfer>) =>
        transfer({
          kind: 'TRANSFER',
          fromSourceId: 'bank',
          toSourceId: 'bank-2',
          amountMinor: 10_000,
          ...changes,
        });
      expect(() =>
        applyTransferEffects(list, null, move({ transferDate: '2026-03-05' }), on, now),
      ).toThrow('change only one account');
      const applied = applyTransferEffects(
        list,
        null,
        move({ transferDate: '2026-03-11' }),
        on,
        now,
      );
      expect([balance(list, 'bank'), balance(list, 'bank-2')]).toEqual([990_000, 310_000]);
      reverseTransferEffects(list, applied, on);
      expect([balance(list, 'bank'), balance(list, 'bank-2')]).toEqual([1_000_000, 300_000]);
      const funding = applyTransferEffects(
        list,
        null,
        transfer({
          id: 'funding',
          kind: 'CARD_SETTLEMENT',
          fromSourceId: 'bank',
          toSourceId: undefined,
          cardId: 'card',
          amountMinor: 5_000,
          transferDate: '2026-03-05',
        }),
        on,
        now,
      );
      expect(funding.effects).toEqual([{ sourceId: 'bank', deltaMinor: -5_000, appliedAt: now }]);
      expect(balance(list, 'bank')).toBe(995_000);
    });
  });

  describe('re-deciding effects when the timing answer or the event date changes', () => {
    const cutover = '2026-03-10T06:30:00.000Z';
    const now = '2026-04-01T00:00:00.000Z';
    const historical = '2026-03-01T00:00:00.000Z';
    const fixed = (): PaymentSource[] =>
      sources().map((source) =>
        source.balanceCutoverAt ? { ...source, balanceCutoverAt: cutover } : source,
      );
    const editEntry = (
      list: PaymentSource[],
      previous: CardTransaction,
      changes: Partial<CardTransaction>,
    ) => {
      reverseBalanceEffect(list, previous.balanceEffect, on);
      return applyBankCashTransaction(list, previous, { ...previous, ...changes }, on, now);
    };
    const editTransfer = (
      list: PaymentSource[],
      previous: SourceTransfer,
      changes: Partial<SourceTransfer>,
    ) => {
      reverseTransferEffects(list, previous, on);
      return applyTransferEffects(list, previous, { ...previous, ...changes }, on, now);
    };
    const answer = (balanceTiming: 'AFTER_BASELINE' | 'INCLUDED_IN_BASELINE') => ({
      balanceTiming,
      balanceTimingAt: now,
    });

    it('a same-day purchase follows AFTER -> INCLUDED -> AFTER without accumulating', () => {
      const list = fixed();
      let purchase = applyBankCashTransaction(
        list,
        null,
        entry({ transactionDate: '2026-03-10', amountMinor: 50_000, ...answer('AFTER_BASELINE') }),
        on,
        now,
      );
      expect(balance(list, 'bank')).toBe(950_000);
      for (let round = 0; round < 3; round += 1) {
        purchase = editEntry(list, purchase, answer('INCLUDED_IN_BASELINE'));
        expect(purchase.balanceEffect).toBeUndefined();
        expect(balance(list, 'bank')).toBe(1_000_000);
        purchase = editEntry(list, purchase, answer('AFTER_BASELINE'));
        expect(purchase.balanceEffect?.deltaMinor).toBe(-50_000);
        expect(balance(list, 'bank')).toBe(950_000);
      }
      reverseBalanceEffect(list, purchase.balanceEffect, on);
      expect(balance(list, 'bank')).toBe(1_000_000);
    });

    it('an explicit time overrides a stale answer in both directions', () => {
      const list = fixed();
      const included = applyBankCashTransaction(
        list,
        null,
        entry({
          transactionDate: '2026-03-10',
          transactionTime: '18:00',
          ...answer('INCLUDED_IN_BASELINE'),
        }),
        on,
        now,
      );
      expect(included.balanceEffect?.deltaMinor).toBe(-45_000);
      const earlier = editEntry(list, included, {
        transactionTime: '09:00',
        ...answer('AFTER_BASELINE'),
      });
      expect(earlier.balanceEffect).toBeUndefined();
      expect(balance(list, 'bank')).toBe(1_000_000);
    });

    for (const [name, fromSourceId, toSourceId] of [
      ['Bank -> Cash', 'bank', 'cash'],
      ['Cash -> Bank', 'cash', 'bank'],
    ] as const) {
      it(`${name}: changing the answer adds or removes both sides exactly once`, () => {
        const list = fixed();
        let move = applyTransferEffects(
          list,
          null,
          transfer({
            fromSourceId,
            toSourceId,
            amountMinor: 5_000,
            transferDate: '2026-03-10',
            ...answer('AFTER_BASELINE'),
          }),
          on,
          now,
        );
        const applied = [balance(list, 'bank'), balance(list, 'cash')];
        expect(move.effects).toHaveLength(2);
        for (let round = 0; round < 3; round += 1) {
          move = editTransfer(list, move, answer('INCLUDED_IN_BASELINE'));
          expect(move.effects).toEqual([]);
          expect([balance(list, 'bank'), balance(list, 'cash')]).toEqual([1_000_000, 20_000]);
          move = editTransfer(list, move, answer('AFTER_BASELINE'));
          expect(move.effects).toHaveLength(2);
          expect([balance(list, 'bank'), balance(list, 'cash')]).toEqual(applied);
        }
      });
    }

    it('a historical purchase or credit moved after the balance applies only once confirmed', () => {
      for (const [type, delta] of [
        ['PURCHASE', -45_000],
        ['CREDIT', 45_000],
      ] as const) {
        const list = fixed();
        const old = applyBankCashTransaction(
          list,
          null,
          entry({
            type,
            transactionDate: '2026-03-05',
            createdAt: historical,
            balanceTiming: undefined,
          }),
          on,
          now,
        );
        expect(old.balanceEffect).toBeUndefined();
        const existing = { createdAt: historical, effects: [old.balanceEffect] };
        expect(needsBaselineConfirmation(list[0], on, '2026-03-05', undefined, existing)).toBe(
          false,
        );
        expect(needsBaselineConfirmation(list[0], on, '2026-03-12', undefined, existing)).toBe(
          true,
        );
        const unconfirmed = editEntry(list, old, { transactionDate: '2026-03-12' });
        expect(unconfirmed.balanceEffect).toBeUndefined();
        const stale = editEntry(list, unconfirmed, {
          balanceTiming: 'AFTER_BASELINE',
          balanceTimingAt: historical,
        });
        expect(stale.balanceEffect).toBeUndefined();
        const included = editEntry(list, stale, answer('INCLUDED_IN_BASELINE'));
        expect(included.balanceEffect).toBeUndefined();
        expect(balance(list, 'bank')).toBe(1_000_000);
        const confirmed = editEntry(list, included, answer('AFTER_BASELINE'));
        expect(confirmed.balanceEffect?.deltaMinor).toBe(delta);
        const renamed = editEntry(list, confirmed, { notes: 'renamed' });
        expect(renamed.balanceEffect).toEqual(confirmed.balanceEffect);
        expect(balance(list, 'bank')).toBe(1_000_000 + delta);
        const movedBack = editEntry(list, renamed, { transactionDate: '2026-03-05' });
        expect(movedBack.balanceEffect).toBeUndefined();
        expect(balance(list, 'bank')).toBe(1_000_000);
        reverseBalanceEffect(list, movedBack.balanceEffect, on);
        expect(balance(list, 'bank')).toBe(1_000_000);
      }
    });

    it('an entry recorded after the balance and corrected to a later date applies without a question', () => {
      const list = fixed();
      const typo = applyBankCashTransaction(
        list,
        null,
        entry({ transactionDate: '2026-03-05', balanceTiming: undefined }),
        on,
        now,
      );
      expect(typo.balanceEffect).toBeUndefined();
      const corrected = editEntry(list, typo, { transactionDate: '2026-03-12' });
      expect(corrected.balanceEffect?.deltaMinor).toBe(-45_000);
    });

    it('an effect already inside a newer balance is never replayed by an edit', () => {
      const list = sources().map((source) =>
        source.id === 'bank' ? { ...source, balanceCutoverAt: '2026-03-01T06:30:00.000Z' } : source,
      );
      const applied = applyBankCashTransaction(
        list,
        null,
        entry({
          transactionDate: '2026-03-05',
          createdAt: '2026-03-05T10:00:00.000Z',
          balanceTiming: undefined,
        }),
        on,
        '2026-03-05T10:00:00.000Z',
      );
      expect(balance(list, 'bank')).toBe(955_000);
      const bank = list.find((source) => source.id === 'bank')!;
      bank.balanceMinor = 900_000;
      bank.balanceCutoverAt = cutover;
      const amountEdit = editEntry(list, applied, { amountMinor: 1_000 });
      expect(amountEdit.balanceEffect).toBeUndefined();
      const moved = editEntry(list, amountEdit, { transactionDate: '2026-03-12' });
      expect(moved.balanceEffect).toBeUndefined();
      expect(balance(list, 'bank')).toBe(900_000);
    });

    it('historical Bank -> Cash, Cash -> Bank and Bank -> Bank transfers moved after the balance need confirmation and post both sides', () => {
      const second: PaymentSource = {
        id: 'bank-2',
        nickname: 'Second fictional bank',
        kind: 'DEBIT',
        institution: 'Slice',
        lastDigits: '7316',
        noLimit: true,
        balanceMinor: 300_000,
        balanceCutoverAt: cutover,
        autoLoad: false,
        archived: false,
      };
      for (const [fromSourceId, toSourceId] of [
        ['bank', 'cash'],
        ['cash', 'bank'],
        ['bank', 'bank-2'],
      ] as const) {
        const list = [...fixed(), { ...second }];
        const totals = () => list.map((source) => source.balanceMinor ?? 0);
        const before = totals();
        const old = applyTransferEffects(
          list,
          null,
          transfer({
            fromSourceId,
            toSourceId,
            kind: 'TRANSFER',
            amountMinor: 5_000,
            transferDate: '2026-03-05',
            createdAt: historical,
            balanceTiming: undefined,
          }),
          on,
          now,
        );
        expect(old.effects).toEqual([]);
        reverseTransferEffects(list, old, on);
        expect(() =>
          applyTransferEffects(list, old, { ...old, transferDate: '2026-03-12' }, on, now),
        ).toThrow(CORRECTION_QUESTION);
        const included = applyTransferEffects(
          list,
          old,
          { ...old, transferDate: '2026-03-12', ...answer('INCLUDED_IN_BASELINE') },
          on,
          now,
        );
        expect(included.effects).toEqual([]);
        expect(totals()).toEqual(before);
        const confirmed = editTransfer(list, included, answer('AFTER_BASELINE'));
        expect(confirmed.effects).toHaveLength(2);
        expect(totals().reduce((sum, value) => sum + value, 0)).toBe(
          before.reduce((sum, value) => sum + value, 0),
        );
        const again = editTransfer(list, confirmed, { description: 'renamed' });
        expect(again.effects).toEqual(confirmed.effects);
        const movedBack = editTransfer(list, again, { transferDate: '2026-03-05' });
        expect(movedBack.effects).toEqual([]);
        expect(totals()).toEqual(before);
        reverseTransferEffects(list, movedBack, on);
        expect(totals()).toEqual(before);
      }
    });

    it('a historical transfer moved between two different balances is still rejected as one-sided', () => {
      const list = fixed().map((source) =>
        source.id === 'bank' ? { ...source, balanceCutoverAt: '2026-03-01T06:30:00.000Z' } : source,
      );
      const old = applyTransferEffects(
        list,
        null,
        transfer({
          transferDate: '2026-02-20',
          createdAt: '2026-02-25T00:00:00.000Z',
          balanceTiming: undefined,
        }),
        on,
        now,
      );
      expect(old.effects).toEqual([]);
      expect(() =>
        editTransfer(list, old, { transferDate: '2026-03-05', ...answer('AFTER_BASELINE') }),
      ).toThrow('change only one account');
      expect([balance(list, 'bank'), balance(list, 'cash')]).toEqual([1_000_000, 20_000]);
    });
  });

  it('parses stored settings defensively', () => {
    expect(parseBankCashTracking(undefined)).toEqual(off);
    expect(parseBankCashTracking('not json')).toEqual(off);
    expect(parseBankCashTracking('{"enabled":true,"askCardSettlementFunding":true}')).toMatchObject(
      {
        enabled: true,
        askCardSettlementFunding: true,
      },
    );
  });
});
