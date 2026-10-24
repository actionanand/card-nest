import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { SqliteDatabase } from './sqlite-database';
import { CardNestStore } from '../services/card-nest-store';
import { APP_ENVIRONMENT } from '../services/app-environment';
import { NATIVE_EXPORT } from '../services/native-export';
import { AppLockService } from '../services/app-lock.service';
import { indiaTodayIso } from '../services/india-date';
import { calculateNetSpending } from '../services/money';
import { CardTransaction, CreditCard, PaymentSource } from '../models/domain';
import { SmsReviewService } from '../../features/sms-sync/sms-review.service';
import { SmsCandidate, SmsEvidence } from '../../features/sms-sync/sms-model';

vi.hoisted(() => vi.resetModules());
vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {
    createConnection: vi.fn(),
    open: vi.fn(),
    query: vi.fn(),
    run: vi.fn(),
    execute: vi.fn(),
    executeSet: vi.fn(),
    beginTransaction: vi.fn(),
    commitTransaction: vi.fn(),
    rollbackTransaction: vi.fn(),
    isJsonValid: vi.fn(),
    close: vi.fn(),
    closeConnection: vi.fn(),
    importFromJson: vi.fn(),
  },
}));

/** Real SQLite behind the native plugin contract. Every identifier here is fictional. */
describe('Bank/UPI and Cash tracking with SQLite', () => {
  let sql: DatabaseSync;
  let database: SqliteDatabase;
  const lock = { locked: signal(false), foreground: signal(true) };
  const today = indiaTodayIso();
  const rows = (statement: string, values: readonly unknown[] = []) =>
    sql.prepare(statement).all(...(values as SQLInputValue[]));
  const count = (table: string) => Number(rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]['n']);
  const settle = () => database.atomic(async () => undefined);
  const card: CreditCard = {
    id: 'fiction-card',
    nickname: 'Fiction card',
    issuerName: 'ICICI',
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
  };
  const evidence = (changes: Partial<SmsEvidence> = {}): SmsEvidence => ({
    id: 'a'.repeat(64),
    providerId: 'synthetic-bank',
    parserVersion: 3,
    kind: 'BANK_DEBIT',
    direction: 'DEBIT',
    purposeHint: 'PURCHASE',
    amountMinor: 45000,
    currency: 'INR',
    eventDate: today,
    eventAt: `${today}T06:30:00Z`,
    receivedAt: Date.now(),
    dateFallback: false,
    issuer: 'ICICI',
    accountDigits: '417',
    merchant: 'HILL FARM MEATS',
    reference: '735182094619',
    evidence: 'Synthetic bank alert',
    ...changes,
  });
  const stage = async (item: SmsEvidence, state = 'PENDING'): Promise<SmsCandidate> => {
    await database.run(
      'INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES(?,?,?,?,?,?,?)',
      [item.id, item.providerId, item.eventAt, item.kind, state, JSON.stringify(item), 'now'],
    );
    return { id: item.id, kind: item.kind, eventAt: item.eventAt, state: 'PENDING', item };
  };
  const purchase = (changes: Partial<CardTransaction>): CardTransaction => ({
    id: crypto.randomUUID(),
    cardId: 'source-cash',
    type: 'PURCHASE',
    amountMinor: 1000,
    currencyCode: 'INR',
    transactionDate: today,
    categoryId: 'other',
    attachmentIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...changes,
  });
  async function boot() {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const review = TestBed.inject(SmsReviewService);
    vi.spyOn(review, 'refresh').mockResolvedValue();
    const balance = (id: string) =>
      store.paymentSources().find((source) => source.id === id)?.balanceMinor;
    const stored = (id: string) =>
      (
        JSON.parse(
          String(
            rows("SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'")[0][
              'encrypted_value'
            ],
          ),
        ) as PaymentSource[]
      ).find((source) => source.id === id)?.balanceMinor;
    return { store, review, balance, stored };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    lock.locked.set(false);
    lock.foreground.set(true);
    sql = new DatabaseSync(':memory:');
    sql.exec('PRAGMA foreign_keys=ON');
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    vi.mocked(CapacitorSQLite.query).mockImplementation(async (options) => ({
      values: rows(options.statement!, options.values),
    }));
    vi.mocked(CapacitorSQLite.run).mockImplementation(async (options) => ({
      changes: {
        changes: Number(
          sql.prepare(options.statement!).run(...((options.values ?? []) as SQLInputValue[]))
            .changes,
        ),
      },
    }));
    vi.mocked(CapacitorSQLite.execute).mockImplementation(async (options) => {
      if (options.transaction) sql.exec('BEGIN');
      try {
        sql.exec(options.statements!);
        if (options.transaction) sql.exec('COMMIT');
      } catch (error) {
        if (options.transaction) sql.exec('ROLLBACK');
        throw error;
      }
      return { changes: { changes: 0 } };
    });
    vi.mocked(CapacitorSQLite.executeSet).mockImplementation(async (options) => {
      for (const item of options.set ?? [])
        sql.prepare(item.statement!).run(...((item.values ?? []) as SQLInputValue[]));
      return { changes: { changes: 0 } };
    });
    vi.mocked(CapacitorSQLite.beginTransaction).mockImplementation(async () => {
      sql.exec('BEGIN');
      return { changes: { changes: 0 } };
    });
    vi.mocked(CapacitorSQLite.commitTransaction).mockImplementation(async () => {
      sql.exec('COMMIT');
      return { changes: { changes: 0 } };
    });
    vi.mocked(CapacitorSQLite.rollbackTransaction).mockImplementation(async () => {
      sql.exec('ROLLBACK');
      return { changes: { changes: 0 } };
    });
    TestBed.configureTestingModule({
      providers: [
        SqliteDatabase,
        CardNestStore,
        SmsReviewService,
        { provide: AppLockService, useValue: lock },
        { provide: APP_ENVIRONMENT, useValue: { smsPageSize: 200, seedDemoData: false } },
        { provide: NATIVE_EXPORT, useValue: {} },
      ],
    });
    database = TestBed.inject(SqliteDatabase);
  });
  afterEach(() => {
    sql.close();
    vi.restoreAllMocks();
  });

  it('approves an ICICI-style UPI debit as spending with tracking off, keeping bank identity and no balance', async () => {
    const { store, review, balance } = await boot();
    expect(store.bankCashTracking().enabled).toBe(false);
    const candidate = await stage(evidence());
    await review.approveBank(candidate, {
      purpose: 'PURCHASE',
      sourceId: 'source-debit',
      amountMinor: 45000,
      description: 'HILL FARM MEATS',
      transactionDate: today,
    });
    const entry = store.transactions().find((item) => item.id === `sms-${candidate.id}`)!;
    expect(entry).toMatchObject({
      type: 'PURCHASE',
      cardId: 'source-debit',
      bankName: 'ICICI Bank',
      accountSuffix: '417',
      merchant: 'HILL FARM MEATS',
      reference: '735182094619',
      origin: 'SMS',
      categoryId: 'groceries',
    });
    expect(entry.transactionTime).toBeUndefined();
    expect(entry.balanceEffect).toBeUndefined();
    expect(calculateNetSpending(store.transactions())).toBe(45000);
    expect(balance('source-debit')).toBeUndefined();
    expect(rows('SELECT state FROM sms_candidates')[0]['state']).toBe('IMPORTED');
    await review.approveBank(candidate, {
      purpose: 'PURCHASE',
      sourceId: 'source-debit',
      amountMinor: 45000,
      description: 'HILL FARM MEATS',
      transactionDate: today,
    });
    expect(count('card_transactions')).toBe(1);
    const card = await stage(evidence({ id: 'b'.repeat(64), purposeHint: 'CARD_REPAYMENT' }));
    await expect(
      review.approveBank(card, {
        purpose: 'CARD_SETTLEMENT',
        sourceId: 'source-debit',
        amountMinor: 45000,
        description: '',
        transactionDate: today,
        cardId: 'fiction-card',
      }),
    ).rejects.toThrow('Choose how');
    lock.locked.set(true);
    await expect(
      review.approveBank(await stage(evidence({ id: 'c'.repeat(64) })), {
        purpose: 'PURCHASE',
        sourceId: 'source-debit',
        amountMinor: 45000,
        description: '',
        transactionDate: today,
      }),
    ).rejects.toThrow('Unlock');
    expect(count('card_transactions')).toBe(1);
  });

  it('migrates legacy per-source tracking to a confirmed baseline without replay or SMS import', async () => {
    await database.initialise();
    await database.run('INSERT INTO app_preferences(key,encrypted_value) VALUES(?,?)', [
      'payment_sources',
      JSON.stringify([
        {
          id: 'source-cash',
          nickname: 'Cash',
          kind: 'CASH',
          noLimit: false,
          balanceMinor: 150000,
          autoLoad: false,
          archived: false,
        },
        {
          id: 'source-debit',
          nickname: 'Bank / UPI',
          kind: 'DEBIT',
          noLimit: true,
          autoLoad: false,
          archived: false,
        },
      ]),
    ]);
    const legacy = purchase({ id: 'legacy-cash', createdAt: '2026-01-01T00:00:00Z' });
    await database.run('INSERT INTO categories(id,name,icon,applies_to) VALUES(?,?,?,?)', [
      'other',
      'Other',
      'category',
      'BOTH',
    ]);
    await database.run('INSERT INTO card_transactions VALUES(?,NULL,?,?,?,?,?,?,?,?)', [
      legacy.id,
      'other',
      'PURCHASE',
      1000,
      'INR',
      today,
      JSON.stringify(legacy),
      'before',
      'before',
    ]);
    await stage(evidence({ id: 'd'.repeat(64) }), 'IGNORED');
    await stage(evidence({ id: 'e'.repeat(64) }));
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(store.bankCashTracking().enabled).toBe(true);
    const cash = () => store.paymentSources().find((source) => source.id === 'source-cash')!;
    expect(cash().balanceMinor).toBe(150000);
    expect(cash().balanceCutoverAt).toBeDefined();
    expect(rows('SELECT reason FROM source_balance_adjustments')).toEqual([
      { reason: 'MIGRATION' },
    ]);
    expect(
      store.paymentSources().find((source) => source.id === 'source-debit')?.balanceMinor,
    ).toBeUndefined();
    store.updateTransaction({ ...legacy, amountMinor: 99 });
    await settle();
    expect(cash().balanceMinor).toBe(150000);
    store.addTransaction(purchase({ id: 'new-cash' }));
    await settle();
    expect(cash().balanceMinor).toBe(149000);
    expect(count('card_transactions')).toBe(2);
    expect(rows('SELECT state FROM sms_candidates ORDER BY id').map((row) => row['state'])).toEqual(
      ['IGNORED', 'PENDING'],
    );
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(count('source_balance_adjustments')).toBe(1);
    expect(
      restarted.paymentSources().find((source) => source.id === 'source-cash')?.balanceMinor,
    ).toBe(149000);
  });

  it('conserves Bank + Cash through withdrawals, deposits, edits, deletes, failures, restart and backup', async () => {
    const { store, balance, stored } = await boot();
    const bank = await store.addBankAccount({
      nickname: 'Fiction ICICI',
      institution: 'ICICI Bank',
      lastDigits: '417',
    });
    await store.enableBankCashTracking({ [bank.id]: 1_000_000, 'source-cash': 20_000 });
    const total = () => (balance(bank.id) ?? 0) + (balance('source-cash') ?? 0);
    const base = { transferDate: today };
    const withdrawal = await store.saveTransfer(
      {
        ...base,
        id: 'withdraw',
        fromSourceId: bank.id,
        toSourceId: 'source-cash',
        amountMinor: 200_000,
      },
      'CREATE',
    );
    expect(withdrawal.kind).toBe('CASH_WITHDRAWAL');
    expect([balance(bank.id), balance('source-cash')]).toEqual([800_000, 220_000]);
    await expect(
      store.saveTransfer(
        {
          ...base,
          id: 'withdraw',
          fromSourceId: bank.id,
          toSourceId: 'source-cash',
          amountMinor: 200_000,
        },
        'CREATE',
      ),
    ).rejects.toThrow('already saved');
    await store.saveTransfer(
      {
        ...base,
        id: 'deposit',
        fromSourceId: 'source-cash',
        toSourceId: bank.id,
        amountMinor: 50_000,
      },
      'CREATE',
    );
    expect([balance(bank.id), balance('source-cash')]).toEqual([850_000, 170_000]);
    expect(total()).toBe(1_020_000);
    await store.saveTransfer(
      {
        ...base,
        id: 'withdraw',
        fromSourceId: bank.id,
        toSourceId: 'source-cash',
        amountMinor: 100_000,
      },
      'UPDATE',
    );
    expect([balance(bank.id), balance('source-cash')]).toEqual([950_000, 70_000]);
    await expect(
      store.saveTransfer(
        {
          ...base,
          id: 'failed',
          fromSourceId: 'source-cash',
          toSourceId: 'source-debit',
          amountMinor: 1_000,
        },
        'CREATE',
      ),
    ).rejects.toThrow('current balance');
    await expect(
      store.saveTransfer(
        { ...base, id: 'same', fromSourceId: bank.id, toSourceId: bank.id, amountMinor: 1_000 },
        'CREATE',
      ),
    ).rejects.toThrow('different');
    expect([stored(bank.id), stored('source-cash')]).toEqual([950_000, 70_000]);
    expect(count('source_transfers')).toBe(2);
    expect(store.transactions()).toEqual([]);
    const backup = await database.exportBackupJson();
    await store.deleteTransfer('deposit');
    expect([balance(bank.id), balance('source-cash')]).toEqual([900_000, 120_000]);
    expect(count('source_transfers')).toBe(1);
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(restarted.transfers().map((item) => item.id)).toEqual(['withdraw']);
    expect(restarted.paymentSources().find((source) => source.id === bank.id)?.balanceMinor).toBe(
      900_000,
    );
    await database.restoreBackupJson(backup);
    await restarted.initialisePreferences();
    expect(
      restarted
        .transfers()
        .map((item) => item.id)
        .sort(),
    ).toEqual(['deposit', 'withdraw']);
    expect(restarted.paymentSources().find((source) => source.id === bank.id)?.balanceMinor).toBe(
      950_000,
    );
    expect(restarted.bankCashTracking().enabled).toBe(true);
    expect(count('source_balance_adjustments')).toBe(2);
  });

  it('records SMS purchases, receipts and own-account transfers on the right account exactly once', async () => {
    const { store, review, balance } = await boot();
    const icici = await store.addBankAccount({
      nickname: 'Fiction ICICI',
      institution: 'ICICI Bank',
      lastDigits: '417',
    });
    const slice = await store.addBankAccount({
      nickname: 'Fiction slice',
      institution: 'Slice',
      lastDigits: '7316',
    });
    await expect(
      store.addBankAccount({ nickname: 'Again', institution: 'ICICI', lastDigits: '417' }),
    ).rejects.toThrow('already enrolled');
    await store.enableBankCashTracking({ [icici.id]: 1_000_000, [slice.id]: 500_000 });
    const b1 = await stage(evidence());
    await review.approveBank(b1, {
      purpose: 'PURCHASE',
      sourceId: icici.id,
      amountMinor: 45000,
      description: 'HILL FARM MEATS',
      transactionDate: today,
    });
    expect(balance(icici.id)).toBe(955_000);
    expect(balance(slice.id)).toBe(500_000);
    const unknown = await stage(
      evidence({ id: 'c'.repeat(64), accountDigits: '999', reference: undefined }),
    );
    await expect(
      review.approveBank(unknown, {
        purpose: 'PURCHASE',
        sourceId: icici.id,
        amountMinor: 45000,
        description: 'FICTIONAL PAYEE',
        transactionDate: today,
      }),
    ).rejects.toThrow('suffix');
    expect(balance(icici.id)).toBe(955_000);
    const a5 = await stage(
      evidence({
        id: 'd'.repeat(64),
        kind: 'BANK_CREDIT',
        direction: 'CREDIT',
        purposeHint: 'INCOMING',
        amountMinor: 770000,
        merchant: 'JAMIE RIVERS',
        reference: '735182094617',
      }),
    );
    await review.approveBank(a5, {
      purpose: 'INCOME',
      sourceId: icici.id,
      amountMinor: 770000,
      description: 'JAMIE RIVERS',
      transactionDate: today,
    });
    expect(balance(icici.id)).toBe(1_725_000);
    expect(store.transactions().find((item) => item.id === `sms-${a5.id}`)).toMatchObject({
      type: 'CREDIT',
      categoryId: 'income',
    });
    expect(calculateNetSpending(store.transactions())).toBe(45000);
    const a4 = await stage(
      evidence({
        id: 'e'.repeat(64),
        amountMinor: 810000,
        merchant: 'ALEX MORGAN',
        reference: '735182094615',
      }),
    );
    await review.approveBank(a4, {
      purpose: 'TRANSFER',
      sourceId: icici.id,
      counterpartySourceId: slice.id,
      amountMinor: 810000,
      description: '',
      transactionDate: today,
    });
    expect([balance(icici.id), balance(slice.id)]).toEqual([915_000, 1_310_000]);
    const a1 = await stage(
      evidence({
        id: 'f'.repeat(64),
        kind: 'BANK_CREDIT',
        direction: 'CREDIT',
        purposeHint: 'INCOMING',
        issuer: 'Slice',
        accountDigits: '7316',
        amountMinor: 810000,
        merchant: 'ALEX MORGAN',
        reference: '735182094615',
        reportedBalanceMinor: 7432050,
      }),
    );
    const approval = {
      purpose: 'TRANSFER' as const,
      sourceId: slice.id,
      counterpartySourceId: icici.id,
      amountMinor: 810000,
      description: '',
      transactionDate: today,
    };
    await expect(review.approveBank(a1, approval)).rejects.toThrow('Possible existing transfer');
    await review.approveBank(a1, { ...approval, existingTransferId: `sms-transfer-${a4.id}` });
    expect([balance(icici.id), balance(slice.id)]).toEqual([915_000, 1_310_000]);
    expect(count('source_transfers')).toBe(1);
    expect(rows('SELECT state FROM sms_candidates WHERE id=?', [a1.id])[0]['state']).toBe(
      'MATCHED_EXISTING',
    );
    expect(calculateNetSpending(store.transactions())).toBe(45000);
  });

  it('funds a card payment from a bank once, without spending, and reverses it on edit/delete', async () => {
    const { store, review, balance } = await boot();
    store.addCard(card);
    await settle();
    const icici = await store.addBankAccount({
      nickname: 'Fiction ICICI',
      institution: 'ICICI Bank',
      lastDigits: '417',
    });
    await store.enableBankCashTracking({ [icici.id]: 2_500_000 });
    await expect(
      store.recordFundedPayment(card.id, 500_000, 'Card payment', icici.id),
    ).rejects.toThrow('Turn on bank deduction');
    store.recordPayment(card.id, 10_000, 'Unfunded payment');
    await settle();
    expect(balance(icici.id)).toBe(2_500_000);
    await store.setCardSettlementFunding(true);
    store.addTransaction(purchase({ id: 'card-buy', cardId: card.id, amountMinor: 1_200_000 }));
    await settle();
    await store.recordFundedPayment(card.id, 500_000, 'Card payment', icici.id);
    expect(balance(icici.id)).toBe(2_000_000);
    expect(store.cardOutstanding(card.id)).toBe(690_000);
    expect(calculateNetSpending(store.transactions())).toBe(1_200_000);
    const payment = store.transactions().find((item) => item.merchant === 'Card payment')!;
    expect(store.fundingFor(payment.id)).toMatchObject({
      kind: 'CARD_SETTLEMENT',
      amountMinor: 500_000,
    });
    store.updateTransaction({ ...payment, amountMinor: 400_000 });
    await settle();
    expect(balance(icici.id)).toBe(2_100_000);
    expect(rows('SELECT amount_minor FROM source_transfers')).toEqual([{ amount_minor: 400_000 }]);
    store.deleteTransaction(payment.id);
    await settle();
    expect(balance(icici.id)).toBe(2_500_000);
    expect(count('source_transfers')).toBe(0);
    expect(store.cardOutstanding(card.id)).toBe(1_190_000);
    // Bank-side SMS first, then the issuer receipt: one payment, one deduction.
    const bankSide = await stage(
      evidence({
        id: '1'.repeat(64),
        purposeHint: 'CARD_REPAYMENT',
        amountMinor: 300_000,
        merchant: undefined,
        reference: 'SYNTHREF7777',
      }),
    );
    await review.approveBank(bankSide, {
      purpose: 'CARD_SETTLEMENT',
      sourceId: icici.id,
      cardId: card.id,
      amountMinor: 300_000,
      description: '',
      transactionDate: today,
    });
    expect(balance(icici.id)).toBe(2_200_000);
    const receipt = await stage(
      evidence({
        id: '2'.repeat(64),
        kind: 'CARD_PAYMENT_RECEIVED',
        direction: undefined,
        purposeHint: undefined,
        cardDigits: '4321',
        accountDigits: undefined,
        amountMinor: 300_000,
        merchant: undefined,
        reference: undefined,
      }),
    );
    await expect(review.approve(receipt, card.id, 300_000, 'Payment received')).rejects.toThrow(
      'Possible existing transaction',
    );
    await review.approve(receipt, card.id, 300_000, 'Payment received', `sms-${bankSide.id}`);
    expect(store.transactions().filter((item) => item.type === 'PAYMENT')).toHaveLength(2);
    expect(balance(icici.id)).toBe(2_200_000);
    expect(store.cardOutstanding(card.id)).toBe(890_000);
    expect(count('source_transfers')).toBe(1);
  });

  it('never replays old entries on enable, freezes balances while off and audits explicit balance settings', async () => {
    const { store, balance } = await boot();
    const icici = await store.addBankAccount({
      nickname: 'Fiction ICICI',
      institution: 'ICICI Bank',
      lastDigits: '417',
    });
    const old = purchase({ id: 'before-tracking', cardId: icici.id, amountMinor: 10_000 });
    store.addTransaction(old);
    await settle();
    await store.enableBankCashTracking({ [icici.id]: 100_000 });
    expect(balance(icici.id)).toBe(100_000);
    store.updateTransaction({ ...old, amountMinor: 20_000 });
    await settle();
    expect(balance(icici.id)).toBe(100_000);
    const tracked = purchase({ id: 'tracked', cardId: icici.id, amountMinor: 5_000 });
    store.addTransaction(tracked);
    await settle();
    expect(balance(icici.id)).toBe(95_000);
    await store.disableBankCashTracking();
    const whileOff = purchase({ id: 'while-off', cardId: icici.id, amountMinor: 1_000 });
    store.addTransaction(whileOff);
    store.deleteTransaction(tracked.id);
    await settle();
    expect(balance(icici.id)).toBe(95_000);
    await store.enableBankCashTracking({ [icici.id]: 90_000 });
    expect(balance(icici.id)).toBe(90_000);
    store.deleteTransaction(whileOff.id);
    await settle();
    expect(balance(icici.id)).toBe(90_000);
    const transactions = count('card_transactions');
    await store.setSourceBalance(icici.id, 85_000, 'Counted at branch');
    expect(balance(icici.id)).toBe(85_000);
    expect(count('card_transactions')).toBe(transactions);
    expect(
      rows('SELECT reason, correction_minor FROM source_balance_adjustments ORDER BY rowid'),
    ).toEqual([
      { reason: 'OPENING', correction_minor: 100_000 },
      { reason: 'REBASE', correction_minor: -5_000 },
      { reason: 'CORRECTION', correction_minor: -5_000 },
    ]);
    store.updatePaymentSource({
      ...store.paymentSources().find((source) => source.id === icici.id)!,
      nickname: 'Renamed',
      archived: true,
    });
    await settle();
    expect(
      store.transactions().some((item) => item.id === old.id && item.cardId === icici.id),
    ).toBe(true);
    expect(store.sourceDetail(icici.id)).toBe('ICICI Bank · A/c ••417');
    expect(store.deleteCategory('other')).toBe(false);
    expect(store.categories().some((category) => category.id === 'other')).toBe(true);
  });
});
