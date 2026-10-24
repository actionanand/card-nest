import { CardTransaction, PaymentSource, SourceTransfer } from '../models/domain';
import { indiaTodayIso } from './india-date';
import { calculateNetSpending } from './money';
import {
  applyBankCashTransaction,
  applyTransferEffects,
  applyWalletTransaction,
  assetEffect,
  bankCashTracked,
  liquidTotals,
  parseBankCashTracking,
  reverseBalanceEffect,
  reverseTransferEffects,
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
