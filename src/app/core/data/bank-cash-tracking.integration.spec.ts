import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
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
import {
  defaultReviewFilters,
  SMS_REVIEW_FILTERS_KEY,
} from '../../features/sms-sync/sms-review-filters';
import { BackupService } from '../services/backup.service';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

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
  let sql: DatabaseSyncType;
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
        BackupService,
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
    store.addTransaction(purchase({ id: 'new-cash', balanceTiming: 'AFTER_BASELINE' }));
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
    const base = { transferDate: today, balanceTiming: 'AFTER_BASELINE' as const };
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
      baselineTiming: 'AFTER_BASELINE',
      paymentMethod: 'UPI',
      paymentMethodDetail: 'BHIM_APP',
      smsAdditionalComment: 'Synthetic grocery purchase',
    });
    expect(balance(icici.id)).toBe(955_000);
    expect(store.transactions().find((item) => item.id === `sms-${b1.id}`)).toMatchObject({
      paymentMethod: 'UPI',
      paymentMethodDetail: 'BHIM_APP',
      smsAdditionalComment: 'Synthetic grocery purchase',
      notes: 'UPI -> BHIM App\nSynthetic grocery purchase\n(Approved SMS discovery)',
    });
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
        baselineTiming: 'AFTER_BASELINE',
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
      baselineTiming: 'AFTER_BASELINE',
      paymentMethod: 'NONE',
      smsAdditionalComment: 'Synthetic cash gift',
    });
    expect(balance(icici.id)).toBe(1_725_000);
    expect(store.transactions().find((item) => item.id === `sms-${a5.id}`)).toMatchObject({
      type: 'CREDIT',
      categoryId: 'income',
      paymentMethod: 'NONE',
      smsAdditionalComment: 'Synthetic cash gift',
      notes: 'Synthetic cash gift\n(Approved SMS discovery)',
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
      baselineTiming: 'AFTER_BASELINE',
      paymentMethod: 'NEFT',
      smsAdditionalComment: 'Moved to synthetic savings account',
    });
    expect([balance(icici.id), balance(slice.id)]).toEqual([915_000, 1_310_000]);
    expect(store.transfers().find((item) => item.id === `sms-transfer-${a4.id}`)).toMatchObject({
      paymentMethod: 'NEFT',
      smsAdditionalComment: 'Moved to synthetic savings account',
      notes: 'NEFT\nMoved to synthetic savings account\n(Approved SMS discovery)',
    });
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
      baselineTiming: 'AFTER_BASELINE' as const,
    };
    await expect(review.approveBank(a1, approval)).rejects.toThrow('Possible existing transfer');
    await review.approveBank(a1, {
      ...approval,
      existingTransferId: `sms-transfer-${a4.id}`,
      paymentMethod: 'UPI_GLOBAL',
      paymentMethodDetail: 'SINGAPORE',
      smsAdditionalComment: 'Matched from the receiving account SMS',
    });
    expect([balance(icici.id), balance(slice.id)]).toEqual([915_000, 1_310_000]);
    expect(store.transfers()[0]).toMatchObject({
      id: `sms-transfer-${a4.id}`,
      paymentMethod: 'UPI_GLOBAL',
      paymentMethodDetail: 'SINGAPORE',
      smsAdditionalComment: 'Matched from the receiving account SMS',
      notes:
        'UPI Global -> Singapore\nMatched from the receiving account SMS\n(Approved SMS discovery)',
    });
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
      baselineTiming: 'AFTER_BASELINE',
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

  it('approves HSBC CRED repayment only explicitly and links later issuer receipt without a second payment', async () => {
    const { store, review, balance } = await boot();
    store.addCard(card);
    await settle();
    const hsbc = await store.addBankAccount({
      nickname: 'Fictional HSBC',
      institution: 'HSBC Bank',
      lastDigits: '2006',
    });
    await store.enableBankCashTracking({ [hsbc.id]: 2_000_000 });
    await store.setCardSettlementFunding(true);
    const bankMessage = await stage(
      evidence({
        id: '3'.repeat(64),
        providerId: 'synthetic-hsbc-provider',
        kind: 'PAYMENT_INITIATED',
        issuer: 'HSBC',
        accountDigits: '2006',
        direction: 'DEBIT',
        purposeHint: 'CARD_REPAYMENT',
        merchant: 'CRED Club',
        reference: '735182094701',
        amountMinor: 652066,
        eventTimeExplicit: false,
      }),
    );
    expect(count('card_transactions')).toBe(0);
    expect(count('source_transfers')).toBe(0);
    expect(balance(hsbc.id)).toBe(2_000_000);

    await review.approveBank(bankMessage, {
      purpose: 'CARD_SETTLEMENT',
      sourceId: hsbc.id,
      cardId: card.id,
      amountMinor: 652066,
      description: 'CRED Club',
      transactionDate: today,
      baselineTiming: 'AFTER_BASELINE',
    });
    expect(count('card_transactions')).toBe(1);
    expect(rows('SELECT type,amount_minor FROM card_transactions')).toEqual([
      { type: 'PAYMENT', amount_minor: 652066 },
    ]);
    expect(balance(hsbc.id)).toBe(1_347_934);

    const receipt = await stage(
      evidence({
        id: '4'.repeat(64),
        kind: 'CARD_PAYMENT_RECEIVED',
        providerId: 'synthetic-issuer-provider',
        issuer: 'ICICI',
        accountDigits: undefined,
        cardDigits: card.lastDigits,
        direction: undefined,
        purposeHint: undefined,
        merchant: 'Payment received',
        reference: undefined,
        amountMinor: 652066,
        eventTimeExplicit: false,
      }),
    );
    await expect(review.approve(receipt, card.id, 652066, 'Payment received')).rejects.toThrow(
      'Possible existing transaction',
    );
    await review.approve(receipt, card.id, 652066, 'Payment received', `sms-${bankMessage.id}`);
    expect(rows('SELECT type,amount_minor FROM card_transactions')).toEqual([
      { type: 'PAYMENT', amount_minor: 652066 },
    ]);
    expect(balance(hsbc.id)).toBe(1_347_934);
    expect(count('source_transfers')).toBe(1);
  });

  it('round trips all Bank/Cash identities, baselines, settings and accounting rows through an encrypted backup', async () => {
    const { store } = await boot();
    store.addCard(card);
    await settle();
    const first = await store.addBankAccount({
      nickname: 'Fiction primary',
      institution: 'Synthetic Bank',
      lastDigits: '417',
    });
    const second = await store.addBankAccount({
      nickname: 'Fiction reserve',
      institution: 'Sample Credit Union',
      lastDigits: '7316',
    });
    await store.enableBankCashTracking({
      [first.id]: 1_000_000,
      [second.id]: 500_000,
      'source-cash': 20_000,
    });
    await store.setCardSettlementFunding(true);
    await store.saveTransfer(
      {
        id: 'backup-withdrawal',
        fromSourceId: first.id,
        toSourceId: 'source-cash',
        amountMinor: 25_000,
        transferDate: today,
        balanceTiming: 'AFTER_BASELINE',
      },
      'CREATE',
    );
    await store.saveTransfer(
      {
        id: 'backup-deposit',
        fromSourceId: 'source-cash',
        toSourceId: first.id,
        amountMinor: 3_000,
        transferDate: today,
        balanceTiming: 'AFTER_BASELINE',
      },
      'CREATE',
    );
    store.addTransaction(
      purchase({
        id: 'backup-bank-purchase',
        cardId: first.id,
        amountMinor: 5_000,
        balanceTiming: 'AFTER_BASELINE',
        notes: 'Fictional purchase note',
      }),
    );
    await settle();
    await store.recordSourceReceipt({
      id: 'backup-cash-receipt',
      sourceId: 'source-cash',
      amountMinor: 5_000,
      transactionDate: today,
      merchant: 'Fictional cash receipt',
      categoryId: 'income',
      balanceTiming: 'AFTER_BASELINE',
    });
    await store.recordFundedPayment(card.id, 10_000, 'Fictional card payment', first.id);
    await store.setSourceBalance(second.id, 512_345, 'Fictional balance correction');
    store.updatePaymentSource({
      ...store.paymentSources().find((source) => source.id === second.id)!,
      archived: true,
    });
    await store.setDurableUiPreference('sms_swipe_actions_enabled', true);
    await settle();
    const filters = JSON.stringify({
      ...defaultReviewFilters(),
      state: 'IMPORTED',
      kind: 'BANK_DEBIT',
      read: 'READ',
    });
    await database.run('INSERT OR REPLACE INTO app_preferences(key,encrypted_value) VALUES(?,?)', [
      SMS_REVIEW_FILTERS_KEY,
      filters,
    ]);
    const before = {
      sources: structuredClone(store.paymentSources()),
      settings: structuredClone(store.bankCashTracking()),
      transactions: [...structuredClone(store.transactions())].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      transfers: [...structuredClone(store.transfers())].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      adjustments: [...structuredClone(store.balanceAdjustments())].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    };
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const encrypted = await backups.create('synthetic-bank-cash-passphrase');
      expect(encrypted.fileName.endsWith('.cnbak')).toBe(true);
      expect(encrypted.contents).not.toContain('Fiction primary');
      expect(encrypted.contents).not.toContain('Synthetic Bank');
      await database.run('DELETE FROM source_transfers');
      await database.run('DELETE FROM source_balance_adjustments');
      await database.run('DELETE FROM card_transactions');
      await database.run('DELETE FROM credit_cards');
      await database.run(
        "DELETE FROM app_preferences WHERE key IN ('payment_sources','bank_cash_tracking','sms_review_filters','sms_swipe_actions_enabled')",
      );
      await backups.restore(encrypted.contents, 'synthetic-bank-cash-passphrase');
      const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
      await restarted.initialisePreferences();
      expect(restarted.paymentSources()).toEqual(before.sources);
      expect(restarted.bankCashTracking()).toEqual(before.settings);
      expect(
        restarted
          .transactions()
          .map((item) => item.id)
          .sort(),
      ).toEqual(before.transactions.map((item) => item.id).sort());
      expect(
        [...restarted.transfers()].sort((left, right) => left.id.localeCompare(right.id)),
      ).toEqual(before.transfers);
      expect(
        [...restarted.balanceAdjustments()].sort((left, right) => left.id.localeCompare(right.id)),
      ).toEqual(before.adjustments);
      expect(restarted.paymentSources()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: first.id,
            nickname: 'Fiction primary',
            institution: 'Synthetic Bank',
            lastDigits: '417',
            archived: false,
            balanceMinor: expect.any(Number),
            balanceCutoverAt: expect.any(String),
            balanceSnapshotMinor: expect.any(Number),
          }),
          expect.objectContaining({
            id: second.id,
            nickname: 'Fiction reserve',
            institution: 'Sample Credit Union',
            lastDigits: '7316',
            archived: true,
            balanceMinor: 512_345,
          }),
        ]),
      );
      expect(restarted.bankCashTracking()).toMatchObject({
        enabled: true,
        askCardSettlementFunding: true,
      });
      expect(restarted.transfers()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'backup-withdrawal', kind: 'CASH_WITHDRAWAL' }),
          expect.objectContaining({ id: 'backup-deposit', kind: 'CASH_DEPOSIT' }),
          expect.objectContaining({
            kind: 'CARD_SETTLEMENT',
            paymentTransactionId: expect.any(String),
          }),
        ]),
      );
      expect(
        restarted.transactions().find((item) => item.id === 'backup-bank-purchase'),
      ).toMatchObject({
        cardId: first.id,
        type: 'PURCHASE',
        amountMinor: 5_000,
        notes: 'Fictional purchase note',
        balanceEffect: { sourceId: first.id, deltaMinor: -5_000 },
      });
      expect(
        restarted.transactions().find((item) => item.id === 'backup-cash-receipt'),
      ).toMatchObject({
        cardId: 'source-cash',
        type: 'CREDIT',
        amountMinor: 5_000,
        balanceEffect: { sourceId: 'source-cash', deltaMinor: 5_000 },
      });
      expect(restarted.smsSwipeActionsEnabled()).toBe(true);
      expect(
        rows('SELECT encrypted_value FROM app_preferences WHERE key=?', [SMS_REVIEW_FILTERS_KEY]),
      ).toEqual([{ encrypted_value: filters }]);
      expect(count('source_transfers')).toBe(before.transfers.length);
      expect(count('source_balance_adjustments')).toBe(before.adjustments.length);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('round trips SMS annotations, notes, decisions and matches through encrypted backup without financial duplication', async () => {
    const { store, review, balance } = await boot();
    store.addCard(card);
    await settle();
    const bank = await store.addBankAccount({
      nickname: 'Fiction annotation bank',
      institution: 'ICICI Bank',
      lastDigits: '417',
    });
    const otherBank = await store.addBankAccount({
      nickname: 'Fiction annotation reserve',
      institution: 'Sample Credit Union',
      lastDigits: '7316',
    });
    await store.enableBankCashTracking({
      [bank.id]: 1_000_000,
      [otherBank.id]: 300_000,
      'source-cash': 20_000,
    });
    await store.setCardSettlementFunding(true);

    const cardSms = await stage(
      evidence({
        id: '3'.repeat(64),
        kind: 'PURCHASE',
        direction: undefined,
        purposeHint: undefined,
        accountDigits: undefined,
        cardDigits: '4321',
        issuer: 'ICICI',
        amountMinor: 12_000,
        merchant: 'FICTION MARKET',
      }),
    );
    await review.approve(cardSms, card.id, 12_000, 'FICTION MARKET', '', 'PENDING', false, '', 0, {
      transactionDate: today,
      paymentMethod: 'CARD_TAP',
      paymentMethodDetail: 'TAP_GPAY',
      smsAdditionalComment: 'Paid by phone at the synthetic market',
    });
    const cardPaymentSms = await stage(
      evidence({
        id: '8'.repeat(64),
        kind: 'CARD_PAYMENT_RECEIVED',
        direction: undefined,
        purposeHint: undefined,
        accountDigits: undefined,
        cardDigits: '4321',
        issuer: 'ICICI',
        amountMinor: 4_000,
        merchant: 'FICTION CARD PAYMENT',
      }),
    );
    await review.approve(
      cardPaymentSms,
      card.id,
      4_000,
      'FICTION CARD PAYMENT',
      '',
      'PENDING',
      false,
      '',
      0,
      {
        transactionDate: today,
        fundingSourceId: bank.id,
        fundingTiming: 'AFTER_BASELINE',
        paymentMethod: 'CARD',
        paymentMethodDetail: 'ONLINE',
        smsAdditionalComment: 'Synthetic card bill payment',
      },
    );
    const bankPurchase = await stage(
      evidence({ id: '4'.repeat(64), amountMinor: 8_000, merchant: 'FICTION GROCER' }),
    );
    await review.approveBank(bankPurchase, {
      purpose: 'PURCHASE',
      sourceId: bank.id,
      amountMinor: 8_000,
      description: 'FICTION GROCER',
      transactionDate: today,
      baselineTiming: 'AFTER_BASELINE',
      paymentMethod: 'UPI',
      paymentMethodDetail: 'BHIM_APP',
      smsAdditionalComment: 'Synthetic groceries',
    });
    const bankReceipt = await stage(
      evidence({
        id: '5'.repeat(64),
        kind: 'BANK_CREDIT',
        direction: 'CREDIT',
        purposeHint: 'INCOMING',
        amountMinor: 6_000,
        merchant: 'FICTION GIFT',
      }),
    );
    await review.approveBank(bankReceipt, {
      purpose: 'INCOME',
      sourceId: bank.id,
      amountMinor: 6_000,
      description: 'FICTION GIFT',
      transactionDate: today,
      baselineTiming: 'AFTER_BASELINE',
      paymentMethod: 'NONE',
      smsAdditionalComment: 'Gift from a fictional relative',
    });
    const bankTransfer = await stage(
      evidence({
        id: '6'.repeat(64),
        kind: 'BANK_TRANSFER',
        direction: 'DEBIT',
        purposeHint: 'ACCOUNT_TRANSFER',
        counterpartyAccountDigits: '7316',
        amountMinor: 5_000,
        merchant: undefined,
      }),
    );
    await review.approveBank(bankTransfer, {
      purpose: 'TRANSFER',
      sourceId: bank.id,
      counterpartySourceId: otherBank.id,
      amountMinor: 5_000,
      description: '',
      transactionDate: today,
      baselineTiming: 'AFTER_BASELINE',
      paymentMethod: 'NEFT',
      smsAdditionalComment: 'Moved to synthetic savings',
    });
    const transferBalances = [balance(bank.id), balance(otherBank.id)];
    await store.saveTransfer(
      {
        id: `sms-transfer-${bankTransfer.id}`,
        fromSourceId: bank.id,
        toSourceId: otherBank.id,
        amountMinor: 5_000,
        transferDate: today,
        balanceTiming: 'AFTER_BASELINE',
        description: 'Fictional transfer label',
      },
      'UPDATE',
    );
    expect([balance(bank.id), balance(otherBank.id)]).toEqual(transferBalances);
    expect(
      store.transfers().find((item) => item.id === `sms-transfer-${bankTransfer.id}`),
    ).toMatchObject({
      paymentMethod: 'NEFT',
      smsAdditionalComment: 'Moved to synthetic savings',
      notes: 'NEFT\nMoved to synthetic savings\n(Approved SMS discovery)',
    });

    const manual = purchase({
      id: 'annotation-match-manual',
      cardId: card.id,
      amountMinor: 7_000,
      merchant: 'SYNTHETIC MANUAL SHOP',
      notes: 'Original manual note',
      balanceTiming: undefined,
    });
    store.addTransaction(manual);
    await settle();
    const beforeMatch = [balance(bank.id), balance(otherBank.id), balance('source-cash')];
    const laterSms = await stage(
      evidence({
        id: '7'.repeat(64),
        kind: 'PURCHASE',
        direction: undefined,
        purposeHint: undefined,
        accountDigits: undefined,
        cardDigits: '4321',
        issuer: 'ICICI',
        amountMinor: 7_000,
        merchant: 'SYNTHETIC MANUAL SHOP',
      }),
    );
    await review.approve(
      laterSms,
      card.id,
      7_000,
      'SYNTHETIC MANUAL SHOP',
      manual.id,
      'PENDING',
      false,
      '',
      0,
      { paymentMethod: 'NONE', smsAdditionalComment: 'Matched later synthetic SMS' },
    );
    expect([balance(bank.id), balance(otherBank.id), balance('source-cash')]).toEqual(beforeMatch);
    expect(count('card_transactions')).toBe(5);
    expect(count('source_transfers')).toBe(2);
    expect(
      rows('SELECT state,transaction_id FROM sms_candidates WHERE id=?', [laterSms.id])[0],
    ).toMatchObject({ state: 'MATCHED_EXISTING', transaction_id: manual.id });

    const cardEntry = store.transactions().find((item) => item.id === `sms-${cardSms.id}`)!;
    const bankEntry = store.transactions().find((item) => item.id === `sms-${bankPurchase.id}`)!;
    const receiptEntry = store.transactions().find((item) => item.id === `sms-${bankReceipt.id}`)!;
    const matchedEntry = store.transactions().find((item) => item.id === manual.id)!;
    const transferEntry = store
      .transfers()
      .find((item) => item.id === `sms-transfer-${bankTransfer.id}`)!;
    expect(cardEntry.notes).toBe(
      'Card tap -> Tap (GPay)\nPaid by phone at the synthetic market\n(Approved SMS discovery)',
    );
    const cardPaymentEntry = store
      .transactions()
      .find((item) => item.id === `sms-${cardPaymentSms.id}`)!;
    expect(cardPaymentEntry.notes).toBe(
      'Card -> Online Transaction\nSynthetic card bill payment\n(Approved SMS discovery)',
    );
    expect(bankEntry.notes).toBe('UPI -> BHIM App\nSynthetic groceries\n(Approved SMS discovery)');
    expect(receiptEntry.notes).toBe('Gift from a fictional relative\n(Approved SMS discovery)');
    expect(transferEntry.notes).toBe('NEFT\nMoved to synthetic savings\n(Approved SMS discovery)');
    expect(
      store.transfers().find((item) => item.paymentTransactionId === cardPaymentEntry.id),
    ).toMatchObject({
      paymentMethod: 'CARD',
      paymentMethodDetail: 'ONLINE',
      smsAdditionalComment: 'Synthetic card bill payment',
      notes: 'Card -> Online Transaction\nSynthetic card bill payment\n(Approved SMS discovery)',
    });
    expect(matchedEntry.notes).toBe('Matched later synthetic SMS\nOriginal manual note');
    expect(matchedEntry.origin).toBeUndefined();

    await database.run('INSERT OR REPLACE INTO app_preferences(key,encrypted_value) VALUES(?,?)', [
      SMS_REVIEW_FILTERS_KEY,
      JSON.stringify({
        ...defaultReviewFilters(),
        state: 'MATCHED_EXISTING',
        source: bank.id,
      }),
    ]);
    const before = {
      transactions: [...structuredClone(store.transactions())].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      transfers: [...structuredClone(store.transfers())].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      sources: structuredClone(store.paymentSources()),
    };
    const plaintext = await database.exportBackupJson();
    expect(plaintext).not.toContain('Synthetic bank alert');
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const encrypted = await backups.create('synthetic-annotation-passphrase');
      await database.run('DELETE FROM source_transfers');
      await database.run('DELETE FROM card_transactions');
      await backups.restore(encrypted.contents, 'synthetic-annotation-passphrase');
      const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
      await restarted.initialisePreferences();
      expect(
        [...restarted.transactions()].sort((left, right) => left.id.localeCompare(right.id)),
      ).toEqual(before.transactions);
      expect(
        [...restarted.transfers()].sort((left, right) => left.id.localeCompare(right.id)),
      ).toEqual(before.transfers);
      expect(restarted.paymentSources()).toEqual(before.sources);
      expect(count('card_transactions')).toBe(before.transactions.length);
      expect(count('source_transfers')).toBe(before.transfers.length);
      for (const item of restarted.transactions().filter((entry) => entry.origin === 'SMS')) {
        expect(item.notes?.split('(Approved SMS discovery)').length).toBe(2);
        expect(item.notes?.trimEnd().endsWith('(Approved SMS discovery)')).toBe(true);
      }
      expect(
        restarted.transactions().find((item) => item.id === `sms-${cardSms.id}`),
      ).toMatchObject({
        paymentMethod: 'CARD_TAP',
        paymentMethodDetail: 'TAP_GPAY',
        smsAdditionalComment: 'Paid by phone at the synthetic market',
      });
      expect(
        restarted.transactions().find((item) => item.id === `sms-${bankPurchase.id}`),
      ).toMatchObject({
        paymentMethod: 'UPI',
        paymentMethodDetail: 'BHIM_APP',
        smsAdditionalComment: 'Synthetic groceries',
      });
      expect(
        restarted.transfers().find((item) => item.id === `sms-transfer-${bankTransfer.id}`),
      ).toMatchObject({
        paymentMethod: 'NEFT',
        smsAdditionalComment: 'Moved to synthetic savings',
      });
      expect(
        restarted
          .transfers()
          .find((item) => item.paymentTransactionId === `sms-${cardPaymentSms.id}`),
      ).toMatchObject({
        kind: 'CARD_SETTLEMENT',
        paymentMethod: 'CARD',
        paymentMethodDetail: 'ONLINE',
        smsAdditionalComment: 'Synthetic card bill payment',
      });
      expect(
        rows('SELECT state,transaction_id FROM sms_candidates WHERE id=?', [laterSms.id])[0],
      ).toMatchObject({ state: 'MATCHED_EXISTING', transaction_id: manual.id });
      expect(
        rows('SELECT encrypted_value FROM app_preferences WHERE key=?', [SMS_REVIEW_FILTERS_KEY]),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('refuses to match a bank-side settlement SMS to a payment funded from a different bank', async () => {
    const { store, review, balance } = await boot();
    store.addCard(card);
    await settle();
    const bankA = await store.addBankAccount({
      nickname: 'Fiction Bank A',
      institution: 'Synthetic Bank A',
      lastDigits: '417',
    });
    const bankB = await store.addBankAccount({
      nickname: 'Fiction Bank B',
      institution: 'Synthetic Bank B',
      lastDigits: '7316',
    });
    await store.enableBankCashTracking({ [bankA.id]: 1_000_000, [bankB.id]: 500_000 });
    await store.setCardSettlementFunding(true);
    await store.recordFundedPayment(card.id, 50_000, 'Synthetic card payment', bankA.id);
    const payment = store
      .transactions()
      .find((entry) => entry.merchant === 'Synthetic card payment')!;
    const transferBefore = store
      .transfers()
      .find((item) => item.paymentTransactionId === payment.id)!;
    const balancesBefore = [balance(bankA.id), balance(bankB.id)];
    const candidate = await stage(
      evidence({
        id: '9'.repeat(64),
        purposeHint: 'CARD_REPAYMENT',
        accountDigits: '7316',
        issuer: undefined,
        amountMinor: payment.amountMinor,
        merchant: 'Synthetic card payment',
      }),
    );

    await expect(
      review.approveBank(candidate, {
        purpose: 'CARD_SETTLEMENT',
        sourceId: bankB.id,
        cardId: card.id,
        existingId: payment.id,
        amountMinor: payment.amountMinor,
        description: 'Synthetic card payment',
        transactionDate: today,
        baselineTiming: 'AFTER_BASELINE',
        allowSeparate: true,
      }),
    ).rejects.toThrow('already funded from Fiction Bank A, not Fiction Bank B');

    expect([balance(bankA.id), balance(bankB.id)]).toEqual(balancesBefore);
    expect(store.transactions()).toHaveLength(1);
    expect(store.transactions()[0]).toEqual(payment);
    expect(store.transfers()).toEqual([transferBefore]);
    expect(count('card_transactions')).toBe(1);
    expect(count('source_transfers')).toBe(1);
    expect(rows('SELECT state FROM sms_candidates WHERE id=?', [candidate.id])[0]['state']).toBe(
      'PENDING',
    );

    const sameBankCandidate = await stage(
      evidence({
        id: '8'.repeat(64),
        purposeHint: 'CARD_REPAYMENT',
        accountDigits: '417',
        issuer: undefined,
        amountMinor: payment.amountMinor,
        merchant: 'Synthetic card payment',
      }),
    );
    await review.approveBank(sameBankCandidate, {
      purpose: 'CARD_SETTLEMENT',
      sourceId: bankA.id,
      cardId: card.id,
      existingId: payment.id,
      amountMinor: payment.amountMinor,
      description: 'Synthetic card payment',
      transactionDate: today,
      baselineTiming: 'AFTER_BASELINE',
      smsAdditionalComment: 'Verified same-bank settlement',
    });
    expect([balance(bankA.id), balance(bankB.id)]).toEqual(balancesBefore);
    expect(count('card_transactions')).toBe(1);
    expect(count('source_transfers')).toBe(1);
    expect(
      rows('SELECT state FROM sms_candidates WHERE id=?', [sameBankCandidate.id])[0]['state'],
    ).toBe('MATCHED_EXISTING');
    expect(store.transfers()[0].smsAdditionalComment).toBe('Verified same-bank settlement');
    const updatedPaymentRow = rows('SELECT payload,updated_at FROM card_transactions WHERE id=?', [
      payment.id,
    ])[0];
    const updatedPaymentPayload = JSON.parse(String(updatedPaymentRow['payload'])) as {
      updatedAt: string;
    };
    expect(updatedPaymentRow['updated_at']).toBe(updatedPaymentPayload.updatedAt);
    const updatedFundingRow = rows(
      'SELECT payload,updated_at FROM source_transfers WHERE payment_transaction_id=?',
      [payment.id],
    )[0];
    const updatedFundingPayload = JSON.parse(String(updatedFundingRow['payload'])) as {
      updatedAt: string;
    };
    expect(updatedFundingRow['updated_at']).toBe(updatedFundingPayload.updatedAt);
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
    const tracked = purchase({
      id: 'tracked',
      cardId: icici.id,
      amountMinor: 5_000,
      balanceTiming: 'AFTER_BASELINE',
    });
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

  const daysAgo = (days: number) => indiaTodayIso(new Date(Date.now() - days * 86_400_000));

  it('posts Bank->Cash, Cash->Bank and Bank->Bank movements on both sides or none across different confirmed balances', async () => {
    const { store, stored } = await boot();
    const bank = await store.addBankAccount({
      nickname: 'Fiction ICICI',
      institution: 'ICICI Bank',
      lastDigits: '417',
    });
    const second = await store.addBankAccount({
      nickname: 'Fiction slice',
      institution: 'Slice',
      lastDigits: '7316',
    });
    await store.enableBankCashTracking({
      [bank.id]: 1_000_000,
      [second.id]: 300_000,
      'source-cash': 20_000,
    });
    // Bank confirmed 10 days ago at 12:00 IST; Cash and the second bank 3 days ago.
    const current = JSON.parse(
      String(
        rows("SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'")[0][
          'encrypted_value'
        ],
      ),
    ) as PaymentSource[];
    await database.run("UPDATE app_preferences SET encrypted_value=? WHERE key='payment_sources'", [
      JSON.stringify(
        current.map((source) =>
          source.id === bank.id
            ? { ...source, balanceCutoverAt: `${daysAgo(10)}T06:30:00.000Z` }
            : source.id === second.id || source.id === 'source-cash'
              ? { ...source, balanceCutoverAt: `${daysAgo(3)}T06:30:00.000Z` }
              : source,
        ),
      ),
    ]);
    const balances = () => [stored(bank.id), stored('source-cash'), stored(second.id)];
    const pairs = [
      { name: 'bank-cash', fromSourceId: bank.id, toSourceId: 'source-cash' },
      { name: 'cash-bank', fromSourceId: 'source-cash', toSourceId: bank.id },
      { name: 'bank-bank', fromSourceId: bank.id, toSourceId: second.id },
    ];
    for (const { name, fromSourceId, toSourceId } of pairs) {
      const move = { fromSourceId, toSourceId, amountMinor: 10_000 };
      const before = balances();
      await expect(
        store.saveTransfer({ ...move, id: `${name}-between`, transferDate: daysAgo(6) }, 'CREATE'),
      ).rejects.toThrow('change only one account');
      await expect(
        store.saveTransfer(
          { ...move, id: `${name}-same-day`, transferDate: daysAgo(3), transferTime: '11:00' },
          'CREATE',
        ),
      ).rejects.toThrow('change only one account');
      expect(balances()).toEqual(before);
      const old = await store.saveTransfer(
        { ...move, id: `${name}-before`, transferDate: daysAgo(20) },
        'CREATE',
      );
      expect(old.effects).toEqual([]);
      expect(balances()).toEqual(before);
      const applied = await store.saveTransfer(
        { ...move, id: `${name}-after`, transferDate: today },
        'CREATE',
      );
      expect(applied.effects).toHaveLength(2);
      const after = balances();
      await expect(
        store.saveTransfer({ ...move, id: `${name}-after`, transferDate: daysAgo(6) }, 'UPDATE'),
      ).rejects.toThrow('change only one account');
      expect(balances()).toEqual(after);
      await store.saveTransfer(
        { ...move, id: `${name}-after`, transferDate: today, description: 'Renamed' },
        'UPDATE',
      );
      expect(balances()).toEqual(after);
    }
    expect(balances()).toEqual([990_000, 20_000, 310_000]);
    expect(count('source_transfers')).toBe(6);
    const backup = await database.exportBackupJson();
    await store.deleteTransfer('bank-bank-after');
    await store.deleteTransfer('bank-cash-before');
    expect(balances()).toEqual([1_000_000, 20_000, 300_000]);
    await database.restoreBackupJson(backup);
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(balances()).toEqual([990_000, 20_000, 310_000]);
    expect(restarted.transfers()).toHaveLength(6);
  });

  it('saves an incoming receipt durably, asks for same-day timing and rejects duplicates', async () => {
    const { store, stored } = await boot();
    await store.enableBankCashTracking({ 'source-cash': 20_000 });
    await database.run(
      'INSERT OR IGNORE INTO categories(id,name,icon,applies_to) VALUES(?,?,?,?),(?,?,?,?)',
      [
        'fiction-in',
        'Fiction incoming',
        'category',
        'CREDIT',
        'fiction-out',
        'Fiction outgoing',
        'category',
        'EXPENSE',
      ],
    );
    const receipt = {
      id: 'receipt-1',
      sourceId: 'source-cash',
      amountMinor: 5_000,
      transactionDate: today,
      merchant: 'Fictional gift',
      categoryId: 'fiction-in',
    };
    await expect(store.recordSourceReceipt(receipt)).rejects.toThrow('no time');
    await expect(
      store.recordSourceReceipt({
        ...receipt,
        categoryId: 'fiction-out',
        balanceTiming: 'AFTER_BASELINE',
      }),
    ).rejects.toThrow('incoming money');
    await expect(
      store.recordSourceReceipt({
        ...receipt,
        sourceId: 'missing',
        balanceTiming: 'AFTER_BASELINE',
      }),
    ).rejects.toThrow('bank account or cash');
    expect(store.transactions()).toEqual([]);
    expect(count('card_transactions')).toBe(0);
    expect(stored('source-cash')).toBe(20_000);
    const saved = await store.recordSourceReceipt({ ...receipt, balanceTiming: 'AFTER_BASELINE' });
    expect(saved.balanceEffect?.deltaMinor).toBe(5_000);
    expect(stored('source-cash')).toBe(25_000);
    expect(count('card_transactions')).toBe(1);
    expect(store.transactions().map((item) => item.id)).toEqual(['receipt-1']);
    await expect(
      store.recordSourceReceipt({ ...receipt, balanceTiming: 'AFTER_BASELINE' }),
    ).rejects.toThrow('already saved');
    expect(stored('source-cash')).toBe(25_000);
    expect(count('card_transactions')).toBe(1);
    const included = await store.recordSourceReceipt({
      ...receipt,
      id: 'receipt-2',
      balanceTiming: 'INCLUDED_IN_BASELINE',
    });
    expect(included.balanceEffect).toBeUndefined();
    expect(stored('source-cash')).toBe(25_000);
  });

  it('asks for the timing of an untimed same-day SMS event and honours an explicit earlier time', async () => {
    const { store, review, balance } = await boot();
    const icici = await store.addBankAccount({
      nickname: 'Fiction ICICI',
      institution: 'ICICI Bank',
      lastDigits: '417',
    });
    await store.enableBankCashTracking({ [icici.id]: 1_000_000 });
    const untimed = await stage(evidence());
    const approval = {
      purpose: 'PURCHASE' as const,
      sourceId: icici.id,
      amountMinor: 45000,
      description: 'HILL FARM MEATS',
      transactionDate: today,
    };
    await expect(review.approveBank(untimed, approval)).rejects.toThrow('no time');
    expect(count('card_transactions')).toBe(0);
    await review.approveBank(untimed, { ...approval, baselineTiming: 'INCLUDED_IN_BASELINE' });
    expect(balance(icici.id)).toBe(1_000_000);
    expect(calculateNetSpending(store.transactions())).toBe(45000);
    const earlier = await stage(
      evidence({
        id: '9'.repeat(64),
        reference: '735182094699',
        eventTime: '00:00:00',
        eventTimeExplicit: true,
        eventAt: `${today}T00:00:00+05:30`,
      }),
    );
    await review.approveBank(earlier, { ...approval, allowSeparate: true });
    expect(balance(icici.id)).toBe(1_000_000);
  });

  it('edits a loan repayment as a one-account deduction and reverses it on delete', async () => {
    const { store, review, balance } = await boot();
    const icici = await store.addBankAccount({
      nickname: 'Fiction ICICI',
      institution: 'ICICI Bank',
      lastDigits: '417',
    });
    await store.enableBankCashTracking({ [icici.id]: 1_000_000 });
    const loanSms = await stage(
      evidence({
        id: '8'.repeat(64),
        kind: 'LOAN_DEBIT',
        purposeHint: 'LOAN_REPAYMENT',
        amountMinor: 50_000,
        merchant: undefined,
        reference: 'SYNTHLOAN0001',
      }),
    );
    await review.approveBank(loanSms, {
      purpose: 'LOAN_REPAYMENT',
      sourceId: icici.id,
      amountMinor: 50_000,
      description: 'Fictional home loan',
      transactionDate: today,
      baselineTiming: 'AFTER_BASELINE',
    });
    expect(balance(icici.id)).toBe(950_000);
    const id = `sms-loan-${loanSms.id}`;
    const edited = await store.saveTransfer(
      {
        id,
        fromSourceId: icici.id,
        amountMinor: 40_000,
        transferDate: today,
        balanceTiming: 'AFTER_BASELINE',
      },
      'UPDATE',
    );
    expect(edited).toMatchObject({ kind: 'LOAN_REPAYMENT', amountMinor: 40_000 });
    expect(edited.toSourceId).toBeUndefined();
    expect(balance(icici.id)).toBe(960_000);
    expect(calculateNetSpending(store.transactions())).toBe(0);
    await store.deleteTransfer(id);
    expect(balance(icici.id)).toBe(1_000_000);
    expect(count('source_transfers')).toBe(0);
  });

  it('re-decides persisted effects when timing answers or historical dates change, through restart, delete and backup', async () => {
    const { store, stored } = await boot();
    const bank = await store.addBankAccount({
      nickname: 'Fiction ICICI',
      institution: 'ICICI Bank',
      lastDigits: '417',
    });
    const second = await store.addBankAccount({
      nickname: 'Fiction slice',
      institution: 'Slice',
      lastDigits: '7316',
    });
    await store.enableBankCashTracking({
      [bank.id]: 1_000_000,
      [second.id]: 300_000,
      'source-cash': 20_000,
    });
    const balances = () => [stored(bank.id), stored('source-cash'), stored(second.id)];
    const answered = (balanceTiming: 'AFTER_BASELINE' | 'INCLUDED_IN_BASELINE') => ({
      balanceTiming,
      balanceTimingAt: new Date().toISOString(),
    });

    // Issue 1: a same-day untimed ₹500 purchase toggled between the two answers.
    const sameDay = purchase({
      id: 'same-day',
      cardId: bank.id,
      amountMinor: 50_000,
      ...answered('AFTER_BASELINE'),
    });
    store.addTransaction(sameDay);
    await settle();
    expect(stored(bank.id)).toBe(950_000);
    for (let round = 0; round < 2; round += 1) {
      store.updateTransaction({ ...sameDay, ...answered('INCLUDED_IN_BASELINE') });
      await settle();
      expect(stored(bank.id)).toBe(1_000_000);
      store.updateTransaction({ ...sameDay, ...answered('AFTER_BASELINE') });
      await settle();
      expect(stored(bank.id)).toBe(950_000);
    }
    for (const [id, fromSourceId, toSourceId] of [
      ['same-day-withdrawal', bank.id, 'source-cash'],
      ['same-day-deposit', 'source-cash', bank.id],
    ]) {
      const move = { id, fromSourceId, toSourceId, amountMinor: 10_000, transferDate: today };
      const before = balances();
      await store.saveTransfer({ ...move, balanceTiming: 'AFTER_BASELINE' }, 'CREATE');
      const applied = balances();
      expect(applied).not.toEqual(before);
      for (let round = 0; round < 2; round += 1) {
        await store.saveTransfer({ ...move, balanceTiming: 'INCLUDED_IN_BASELINE' }, 'UPDATE');
        expect(balances()).toEqual(before);
        await store.saveTransfer({ ...move, balanceTiming: 'AFTER_BASELINE' }, 'UPDATE');
        expect(balances()).toEqual(applied);
      }
    }
    expect(balances()).toEqual([950_000, 20_000, 300_000]);

    // Issue 2: entries recorded before a balance confirmation, later redated after it.
    const tomorrow = indiaTodayIso(new Date(Date.now() + 86_400_000));
    const oldBuy = purchase({
      id: 'old-buy',
      cardId: bank.id,
      amountMinor: 7_000,
      transactionDate: daysAgo(5),
    });
    const oldCredit = purchase({
      id: 'old-credit',
      cardId: 'source-cash',
      type: 'CREDIT',
      amountMinor: 3_000,
      transactionDate: daysAgo(5),
    });
    store.addTransaction(oldBuy);
    store.addTransaction(oldCredit);
    await settle();
    const historical = [
      {
        id: 'old-withdrawal',
        fromSourceId: bank.id,
        toSourceId: 'source-cash',
        amountMinor: 1_000,
      },
      { id: 'old-deposit', fromSourceId: 'source-cash', toSourceId: bank.id, amountMinor: 2_000 },
      { id: 'old-bank-bank', fromSourceId: bank.id, toSourceId: second.id, amountMinor: 4_000 },
    ];
    for (const move of historical)
      expect(
        (await store.saveTransfer({ ...move, transferDate: daysAgo(5) }, 'CREATE')).effects,
      ).toEqual([]);
    expect(balances()).toEqual([950_000, 20_000, 300_000]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.enableBankCashTracking({
      [bank.id]: 950_000,
      [second.id]: 300_000,
      'source-cash': 20_000,
    });

    store.updateTransaction({ ...oldBuy, transactionDate: tomorrow });
    store.updateTransaction({ ...oldCredit, transactionDate: tomorrow });
    await settle();
    expect(balances()).toEqual([950_000, 20_000, 300_000]);
    store.updateTransaction({
      ...oldBuy,
      transactionDate: tomorrow,
      ...answered('AFTER_BASELINE'),
    });
    store.updateTransaction({
      ...oldCredit,
      transactionDate: tomorrow,
      ...answered('AFTER_BASELINE'),
    });
    await settle();
    expect(balances()).toEqual([943_000, 23_000, 300_000]);
    store.updateTransaction({
      ...oldBuy,
      transactionDate: tomorrow,
      notes: 'renamed',
      ...answered('AFTER_BASELINE'),
    });
    await settle();
    expect(balances()).toEqual([943_000, 23_000, 300_000]);
    for (const move of historical) {
      await expect(
        store.saveTransfer({ ...move, transferDate: tomorrow }, 'UPDATE'),
      ).rejects.toThrow('existed when the balance was confirmed');
      const saved = await store.saveTransfer(
        { ...move, transferDate: tomorrow, balanceTiming: 'AFTER_BASELINE' },
        'UPDATE',
      );
      expect(saved.effects).toHaveLength(2);
      await store.saveTransfer(
        { ...move, transferDate: tomorrow, description: 'Renamed' },
        'UPDATE',
      );
    }
    const final = [940_000, 22_000, 304_000];
    expect(balances()).toEqual(final);
    // Effects applied before the newer balance are inside it and are not reversed again.
    store.deleteTransaction('same-day');
    await settle();
    await store.deleteTransfer('same-day-withdrawal');
    expect(balances()).toEqual(final);

    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(balances()).toEqual(final);
    const backup = await database.exportBackupJson();
    for (const move of historical) await restarted.deleteTransfer(move.id);
    store.deleteTransaction('old-buy');
    store.deleteTransaction('old-credit');
    await settle();
    expect(balances()).toEqual([950_000, 20_000, 300_000]);
    await database.restoreBackupJson(backup);
    await restarted.initialisePreferences();
    expect(balances()).toEqual(final);
    expect(
      restarted
        .transfers()
        .filter((item) => historical.some((move) => move.id === item.id))
        .every((item) => item.effects?.length === 2),
    ).toBe(true);
  });
});
