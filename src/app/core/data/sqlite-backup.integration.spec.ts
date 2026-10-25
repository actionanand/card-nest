import { TestBed } from '@angular/core/testing';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { SqliteDatabase } from './sqlite-database';
import { DATABASE_MIGRATIONS } from './migrations';
import { CardNestStore } from '../services/card-nest-store';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { APP_ENVIRONMENT } from '../services/app-environment';
import { reviewFilters } from '../../features/sms-sync/sms-review-filters';
import { BackupService } from '../services/backup.service';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { NATIVE_EXPORT } from '../services/native-export';
import { AppLockService } from '../services/app-lock.service';
import { SmsReviewService } from '../../features/sms-sync/sms-review.service';
import { SmsCandidate, SmsEvidence } from '../../features/sms-sync/sms-model';

vi.hoisted(() => vi.resetModules());
const config = { smsPageSize: 200, seedDemoData: false };
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

/** Native-plugin contract backed by real SQLite, including transactions and foreign keys. */
describe('Durable first-run data, additive read migration and private portable backups', () => {
  let sql: DatabaseSync;
  let database: SqliteDatabase;
  it('persists default-off UI preferences through serialized writes, reload and encrypted backup restoration', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(store.smsSwipeActionsEnabled()).toBe(false);
    expect(store.showTransactionTime()).toBe(false);
    await Promise.all([
      store.setDurableUiPreference('sms_swipe_actions_enabled', true),
      store.setDurableUiPreference('show_transaction_time', true),
    ]);
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-preference-passphrase');
      expect(backup.contents).not.toContain('sms_swipe_actions_enabled');
      await store.setDurableUiPreference('show_transaction_time', false);
      await backups.restore(backup.contents, 'synthetic-preference-passphrase');
      await store.initialisePreferences();
      expect(store.smsSwipeActionsEnabled()).toBe(true);
      expect(store.showTransactionTime()).toBe(true);
      await database.run(
        "UPDATE app_preferences SET encrypted_value='invalid' WHERE key='show_transaction_time'",
      );
      await database.run("DELETE FROM app_preferences WHERE key='sms_swipe_actions_enabled'");
      await store.initialisePreferences();
      expect(store.showTransactionTime()).toBe(false);
      expect(store.smsSwipeActionsEnabled()).toBe(false);
      await database.run("DELETE FROM app_preferences WHERE key='show_transaction_time'");
      const oldBackup = await backups.create('synthetic-preference-passphrase');
      await store.setDurableUiPreference('sms_swipe_actions_enabled', true);
      await store.setDurableUiPreference('show_transaction_time', true);
      await backups.restore(oldBackup.contents, 'synthetic-preference-passphrase');
      await store.initialisePreferences();
      expect(store.showTransactionTime()).toBe(false);
      expect(store.smsSwipeActionsEnabled()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('keeps the SQLite budget and cycle through reload and encrypted restore, including older unset backups', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(store.monthlyBudgetMinor()).toBe(0);
    await store.setMonthlyBudget(654321);
    await store.setBudgetCycleStartDay(12);
    const restartedStore = TestBed.runInInjectionContext(() => new CardNestStore());
    await restartedStore.initialisePreferences();
    expect(restartedStore.monthlyBudgetMinor()).toBe(654321);
    expect(restartedStore.budgetCycleStartDay()).toBe(12);
    await store.initialisePreferences();
    expect(store.monthlyBudgetMinor()).toBe(654321);
    expect(store.budgetCycleStartDay()).toBe(12);
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-budget-passphrase');
      expect(backup.contents).not.toContain('monthly_budget_minor');
      await store.setMonthlyBudget(100);
      await store.setBudgetCycleStartDay(5);
      await backups.restore(backup.contents, 'synthetic-budget-passphrase');
      await store.initialisePreferences();
      expect(store.monthlyBudgetMinor()).toBe(654321);
      expect(store.budgetCycleStartDay()).toBe(12);
      await database.run(
        "DELETE FROM app_preferences WHERE key IN ('monthly_budget_minor','budget_cycle_start_day')",
      );
      const oldBackup = await backups.create('synthetic-budget-passphrase');
      await store.setMonthlyBudget(100);
      await store.setBudgetCycleStartDay(5);
      await backups.restore(oldBackup.contents, 'synthetic-budget-passphrase');
      await store.initialisePreferences();
      expect(store.monthlyBudgetMinor()).toBe(0);
      expect(store.budgetCycleStartDay()).toBe(1);
      expect(store.displayCurrencyCode()).toBe('INR');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  const rows = (statement: string, values: readonly unknown[] = []) =>
    sql.prepare(statement).all(...(values as SQLInputValue[]));
  const count = (table: string) => Number(rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]['n']);
  const marker = () =>
    rows("SELECT encrypted_value FROM app_preferences WHERE key='initial_data_state'")[0]?.[
      'encrypted_value'
    ];
  it('backs up and restores applied SMS filters, including search, with normal preferences', async () => {
    await database.initialise();
    const filters = JSON.stringify({
      state: 'DEFERRED',
      kind: 'REFUND',
      search: 'Synthetic shop',
      source: '54321',
      from: '2026-01-01',
      to: '2026-02-28',
      read: 'READ',
    });
    await database.run('INSERT INTO app_preferences VALUES(?,?)', ['sms_review_filters', filters]);
    const backup = await database.exportBackupJson();
    await database.run('UPDATE app_preferences SET encrypted_value=? WHERE key=?', [
      '{}',
      'sms_review_filters',
    ]);
    await database.restoreBackupJson(backup);
    expect(
      rows("SELECT encrypted_value FROM app_preferences WHERE key='sms_review_filters'"),
    ).toEqual([{ encrypted_value: filters }]);
    await database.deleteAllData();
    expect(
      rows("SELECT encrypted_value FROM app_preferences WHERE key='sms_review_filters'"),
    ).toEqual([]);
  });
  function schema(version: number): void {
    for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= version))
      for (const statement of migration.statements) sql.exec(statement);
    sql.exec(`PRAGMA user_version=${version}`);
  }
  function installFinancialData(): void {
    sql.exec(`INSERT INTO categories(id,name,icon,applies_to) VALUES('synthetic-category','Synthetic','category','BOTH');
      INSERT INTO credit_cards(id,nickname,issuer_name,last_digits,network,payload,created_at,updated_at) VALUES('synthetic-card','Synthetic existing','Fictional Bank','54321','AMERICAN_EXPRESS','{}','before','before');
      INSERT INTO card_transactions VALUES('synthetic-transaction','synthetic-card','synthetic-category','PURCHASE',12345,'INR','2026-10-01','{"manual":true}','before','before');
      INSERT INTO app_preferences VALUES('payment_sources','[{"id":"synthetic-wallet","kind":"MEAL","balanceMinor":654321}]');
      INSERT INTO loan_commitments VALUES('synthetic-loan','ACTIVE','{"amount":54321}','before');
      INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,transaction_id,updated_at) VALUES('synthetic-read','1','2026-10-01','PURCHASE','IMPORTED','{"evidence":"Synthetic private evidence"}','synthetic-transaction','before');
      INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES('synthetic-pending','2','2026-10-02','PURCHASE','PENDING','{"evidence":"Synthetic pending evidence"}','before');
      INSERT INTO sms_reconciliation VALUES('synthetic-binding','synthetic-read','synthetic-transaction','IMPORT',12345,'before');`);
  }
  beforeEach(() => {
    vi.clearAllMocks();
    config.seedDemoData = false;
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
        { provide: AppLockService, useValue: { locked: () => false, foreground: () => true } },
        { provide: APP_ENVIRONMENT, useValue: config },
        { provide: NATIVE_EXPORT, useValue: {} },
      ],
    });
    database = TestBed.inject(SqliteDatabase);
  });
  afterEach(() => {
    sql.close();
    vi.restoreAllMocks();
  });
  it('restores an encrypted backup created before optional SMS annotation fields existed', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const legacyCard = {
      id: 'legacy-annotation-card',
      nickname: 'Legacy synthetic card',
      issuerName: 'Fictional Bank',
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
      createdAt: '2026-10-01',
      updatedAt: '2026-10-01',
    };
    const legacyTransaction = {
      id: 'legacy-annotation-transaction',
      cardId: legacyCard.id,
      type: 'PURCHASE',
      amountMinor: 12345,
      currencyCode: 'INR',
      transactionDate: '2026-10-02',
      merchant: 'Fictional legacy merchant',
      categoryId: 'other',
      notes: 'Existing legacy note\nApproved SMS discovery',
      attachmentIds: [],
      createdAt: '2026-10-02T10:00:00Z',
      updatedAt: '2026-10-02T10:00:00Z',
    };
    await database.run(
      'INSERT INTO credit_cards(id,nickname,issuer_name,last_digits,network,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      [
        legacyCard.id,
        legacyCard.nickname,
        legacyCard.issuerName,
        legacyCard.lastDigits,
        legacyCard.network,
        JSON.stringify(legacyCard),
        legacyCard.createdAt,
        legacyCard.updatedAt,
      ],
    );
    await database.run(
      'INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        legacyTransaction.id,
        legacyCard.id,
        'other',
        'PURCHASE',
        legacyTransaction.amountMinor,
        'INR',
        legacyTransaction.transactionDate,
        JSON.stringify(legacyTransaction),
        legacyTransaction.createdAt,
        legacyTransaction.updatedAt,
      ],
    );
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-legacy-passphrase');
      await database.run('DELETE FROM card_transactions');
      await database.run('DELETE FROM credit_cards');
      await backups.restore(backup.contents, 'synthetic-legacy-passphrase');
      const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
      await restarted.initialisePreferences();
      const restored = restarted.transactions()[0];
      expect(restored).toMatchObject(legacyTransaction);
      expect(restored.paymentMethod).toBeUndefined();
      expect(restored.paymentMethodDetail).toBeUndefined();
      expect(restored.paymentMethodCustom).toBeUndefined();
      expect(restored.smsAdditionalComment).toBeUndefined();
      expect(count('card_transactions')).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('deducts 15 actual meal purchases exactly once, preserves legacy snapshots and does not manufacture a fresh cutover', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const meal = store.paymentSources().find((source) => source.kind === 'MEAL')!;
    expect(meal.balanceCutoverAt).toBeUndefined();
    const initialPurchase = {
      id: 'synthetic-fresh-purchase',
      cardId: meal.id,
      type: 'PURCHASE' as const,
      amountMinor: 100,
      currencyCode: 'INR',
      transactionDate: '2026-10-22',
      categoryId: 'dining',
      attachmentIds: [],
      createdAt: '2026-10-22T00:00:00Z',
      updatedAt: '2026-10-22T00:00:00Z',
    };
    store.addTransaction(initialPurchase);
    await database.atomic(async () => undefined);
    await store.initialisePreferences();
    expect(store.paymentSources().find((source) => source.id === meal.id)?.balanceMinor).toBe(-100);
    store.deleteTransaction(initialPurchase.id);
    await database.atomic(async () => undefined);
    const initialBalance = 1097632;
    const wallets = store
      .paymentSources()
      .map((source) =>
        source.id === meal.id
          ? { ...source, balanceMinor: initialBalance, autoLoad: true }
          : source,
      );
    await database.run('INSERT OR REPLACE INTO app_preferences VALUES(?,?)', [
      'payment_sources',
      JSON.stringify(wallets),
    ]);
    await store.initialisePreferences();
    expect(store.paymentSources().find((source) => source.id === meal.id)).toMatchObject({
      autoLoad: false,
      balanceMinor: initialBalance,
    });
    expect(
      store.paymentSources().find((source) => source.id === meal.id)?.balanceCutoverAt,
    ).toBeUndefined();
    const amounts = [...Array.from({ length: 14 }, () => 60000), 163908];
    for (const [index, amountMinor] of amounts.entries())
      store.addTransaction({
        id: `synthetic-meal-purchase-${index}`,
        cardId: meal.id,
        type: 'PURCHASE',
        amountMinor,
        currencyCode: 'INR',
        transactionDate: '2026-10-22',
        transactionTime: `${String(index + 1).padStart(2, '0')}:00:00`,
        categoryId: 'dining',
        merchant: 'Fictional dining',
        attachmentIds: [],
        createdAt: '2026-10-22T00:00:00Z',
        updatedAt: '2026-10-22T00:00:00Z',
      });
    await database.atomic(async () => undefined);
    expect(store.transactions().reduce((sum, entry) => sum + entry.amountMinor, 0)).toBe(1003908);
    expect(store.paymentSources().find((source) => source.id === meal.id)?.balanceMinor).toBe(
      93724,
    );
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(restarted.transactions()).toHaveLength(15);
    expect(restarted.paymentSources().find((source) => source.id === meal.id)?.balanceMinor).toBe(
      93724,
    );
    expect(
      restarted.paymentSources().find((source) => source.id === meal.id)?.balanceCutoverAt,
    ).toBeUndefined();
    const snapshot = '2026-10-23T00:00:00Z';
    await database.run("UPDATE app_preferences SET encrypted_value=? WHERE key='payment_sources'", [
      JSON.stringify(
        restarted.paymentSources().map((source) =>
          source.id === meal.id
            ? {
                ...source,
                autoLoad: true,
                balanceCutoverAt: snapshot,
                balanceSnapshotMinor: 93724,
              }
            : source,
        ),
      ),
    ]);
    await restarted.initialisePreferences();
    expect(restarted.paymentSources().find((source) => source.id === meal.id)).toMatchObject({
      autoLoad: false,
      balanceMinor: 93724,
      balanceCutoverAt: snapshot,
      balanceSnapshotMinor: 93724,
    });
    expect(count('card_transactions')).toBe(15);
  });
  it('persists the Pluxee baseline repair, later purchases, edits, concurrent preferences and encrypted restore without replay', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallet = store.paymentSources().find((source) => source.kind === 'MEAL')!;
    await database.run('INSERT INTO categories(id,name,icon,applies_to) VALUES(?,?,?,?)', [
      'synthetic-kids',
      'Synthetic Kids',
      'category',
      'BOTH',
    ]);
    await database.run('INSERT OR REPLACE INTO app_preferences VALUES(?,?)', [
      'payment_sources',
      JSON.stringify(
        store.paymentSources().map((source) =>
          source.id === wallet.id
            ? {
                ...source,
                balanceMinor: 333124,
                balanceCutoverAt: '2026-10-23T12:15:00Z',
                balanceSnapshotMinor: 333124,
              }
            : source,
        ),
      ),
    ]);
    await store.initialisePreferences();
    const otherSources = store.paymentSources().filter((source) => source.id !== wallet.id);
    for (const [index, amountMinor] of [
      ...Array.from({ length: 14 }, () => 60000),
      163908,
    ].entries())
      store.addTransaction({
        id: `synthetic-retained-${index}`,
        cardId: wallet.id,
        type: 'PURCHASE',
        amountMinor,
        currencyCode: 'INR',
        transactionDate: '2026-10-22',
        categoryId: index % 2 ? 'synthetic-kids' : 'groceries',
        sourceBalanceApplied: false,
        attachmentIds: [],
        createdAt: '2026-10-22T00:00:00Z',
        updatedAt: '2026-10-22T00:00:00Z',
      });
    await database.atomic(async () => undefined);
    const history = rows('SELECT payload FROM card_transactions ORDER BY id');
    const review = TestBed.inject(SmsReviewService);
    vi.spyOn(review, 'refresh').mockResolvedValue();
    const topup: SmsEvidence = {
      id: 'd'.repeat(64),
      providerId: 'synthetic-repair',
      kind: 'PLUXEE_TOPUP',
      issuer: 'Pluxee',
      amountMinor: 880000,
      currency: 'INR',
      eventDate: '2026-10-23',
      eventTime: '05:17:27',
      eventAt: '2026-10-22T23:47:27Z',
      eventTimeExplicit: true,
      timeZone: 'Asia/Kolkata',
      receivedAt: 1792712847000,
      dateFallback: false,
      balancePosition: 'AFTER',
      reportedBalanceMinor: 973724,
      evidence: 'Synthetic meal wallet credit',
    };
    const stage = async (item: SmsEvidence): Promise<SmsCandidate> => {
      await database.run(
        "INSERT OR IGNORE INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES(?,?,?,?,'PENDING',?,'now')",
        [item.id, item.providerId, item.eventAt, item.kind, JSON.stringify(item)],
      );
      return { id: item.id, kind: item.kind, eventAt: item.eventAt, state: 'PENDING', item };
    };
    const candidate = await stage(topup);
    expect(rows("SELECT COUNT(*) AS n FROM card_transactions WHERE type='CREDIT'")[0]['n']).toBe(0);
    expect(store.paymentSources().find((source) => source.id === wallet.id)?.balanceMinor).toBe(
      333124,
    );
    await Promise.all([
      review.approve(candidate, wallet.id, 880000, 'Meal wallet top-up'),
      review.approve(candidate, wallet.id, 880000, 'Meal wallet top-up'),
    ]);
    const repaired = () => store.paymentSources().find((source) => source.id === wallet.id)!;
    expect(repaired()).toMatchObject({
      balanceMinor: 973724,
      balanceCutoverAt: topup.eventAt,
      balanceCutoverReason: 'SMS_RECONCILIATION',
      balanceSnapshotMinor: 973724,
      balanceReconciliation: {
        candidateId: topup.id,
        transactionId: `sms-${topup.id}`,
        savedBalanceMinor: 333124,
        predictedBalanceMinor: 1213124,
        reportedBalanceMinor: 973724,
        correctionMinor: -239400,
      },
    });
    expect(rows("SELECT payload FROM card_transactions WHERE type='PURCHASE' ORDER BY id")).toEqual(
      history,
    );
    expect(count('card_transactions')).toBe(16);
    const purchase = await stage({
      ...topup,
      id: 'e'.repeat(64),
      kind: 'PLUXEE_PURCHASE',
      amountMinor: 50000,
      eventTime: '06:00:00',
      eventAt: '2026-10-23T00:30:00Z',
      reportedBalanceMinor: undefined,
    });
    await review.approve(purchase, wallet.id, 50000, 'Fictional breakfast');
    expect(repaired().balanceMinor).toBe(923724);
    const second = await stage({
      ...purchase.item!,
      id: 'f'.repeat(64),
      amountMinor: 25000,
      eventTime: '07:00:00',
      eventAt: '2026-10-23T01:30:00Z',
    });
    const approval = review.approve(second, wallet.id, 25000, 'Fictional lunch');
    store.updatePaymentSource({ ...repaired(), nickname: 'Renamed Pluxee wallet' });
    await approval;
    await database.atomic(async () => undefined);
    expect(repaired().balanceMinor).toBe(898724);
    expect(repaired().nickname).toBe('Renamed Pluxee wallet');
    const firstPurchase = store.transactions().find((entry) => entry.id === `sms-${purchase.id}`)!;
    expect(firstPurchase.categoryId).toBe('dining');
    store.updateTransaction({ ...firstPurchase, amountMinor: 40000 });
    await database.atomic(async () => undefined);
    expect(repaired().balanceMinor).toBe(908724);
    store.deleteTransaction(firstPurchase.id);
    await database.atomic(async () => undefined);
    expect(repaired().balanceMinor).toBe(948724);
    expect(store.paymentSources().filter((source) => source.id !== wallet.id)).toEqual(
      otherSources,
    );
    const expectedSource = repaired();
    const audit = rows('SELECT * FROM sms_reconciliation ORDER BY id');
    const expectedLedger = rows('SELECT * FROM card_transactions ORDER BY id');
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-wallet-passphrase');
      expect(backup.contents).not.toContain('synthetic-retained');
      await database.deleteAllData();
      await backups.restore(backup.contents, 'synthetic-wallet-passphrase');
      const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
      await restarted.initialisePreferences();
      expect(restarted.paymentSources().find((source) => source.id === wallet.id)).toEqual(
        expectedSource,
      );
      expect(restarted.categories().some((category) => category.id === 'synthetic-kids')).toBe(
        true,
      );
      expect(rows('SELECT * FROM sms_reconciliation ORDER BY id')).toEqual(audit);
      expect(rows('SELECT * FROM card_transactions ORDER BY id')).toEqual(expectedLedger);
      await stage(topup);
      await review.approve(candidate, wallet.id, 880000, 'Meal wallet top-up');
      expect(rows('SELECT * FROM card_transactions ORDER BY id')).toEqual(expectedLedger);
      expect(
        restarted.paymentSources().find((source) => source.id === wallet.id)?.balanceMinor,
      ).toBe(948724);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('keeps a verified Pluxee anchor stable when earlier history is edited, deleted or moved, while later activity applies normally', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const wallet = store.paymentSources().find((source) => source.kind === 'MEAL')!;
    const balance = () => store.paymentSources().find((source) => source.id === wallet.id)!;
    const storedBalance = () =>
      (
        JSON.parse(
          String(
            rows("SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'")[0][
              'encrypted_value'
            ],
          ),
        ) as { id: string; balanceMinor?: number }[]
      ).find((source) => source.id === wallet.id)?.balanceMinor;
    const settle = () => database.atomic(async () => undefined);
    await database.run('INSERT OR REPLACE INTO app_preferences VALUES(?,?)', [
      'payment_sources',
      JSON.stringify(
        store
          .paymentSources()
          .map((source) =>
            source.id === wallet.id
              ? { ...source, balanceMinor: 438124, balanceCutoverAt: '2026-10-23T12:15:00Z' }
              : source,
          ),
      ),
    ]);
    await store.initialisePreferences();
    const otherSources = store.paymentSources().filter((source) => source.id !== wallet.id);
    const base = {
      cardId: wallet.id,
      type: 'PURCHASE' as const,
      currencyCode: 'INR',
      categoryId: 'groceries',
      attachmentIds: [],
      createdAt: '2026-10-22T00:00:00Z',
      updatedAt: '2026-10-22T00:00:00Z',
    };
    // 1. Historical purchases whose effects were applied before the anchor exists.
    store.addTransaction({
      ...base,
      id: 'history-a',
      amountMinor: 100000,
      transactionDate: '2026-10-22',
    });
    store.addTransaction({
      ...base,
      id: 'history-b',
      amountMinor: 5000,
      transactionDate: '2026-10-23',
      transactionTime: '04:00:00',
    });
    await settle();
    expect(balance().balanceMinor).toBe(333124);
    const review = TestBed.inject(SmsReviewService);
    vi.spyOn(review, 'refresh').mockResolvedValue();
    const evidence = (changes: Partial<SmsEvidence>): SmsEvidence => ({
      id: 'a'.repeat(64),
      providerId: 'synthetic-anchor',
      kind: 'PLUXEE_TOPUP',
      issuer: 'Pluxee',
      amountMinor: 880000,
      currency: 'INR',
      eventDate: '2026-10-23',
      eventTime: '05:17:27',
      eventAt: '2026-10-22T23:47:27Z',
      eventTimeExplicit: true,
      timeZone: 'Asia/Kolkata',
      receivedAt: 1792712847000,
      dateFallback: false,
      balancePosition: 'AFTER',
      reportedBalanceMinor: 973724,
      evidence: 'Synthetic meal wallet event',
      ...changes,
    });
    const stage = async (item: SmsEvidence): Promise<SmsCandidate> => {
      await database.run(
        "INSERT OR IGNORE INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES(?,?,?,?,'PENDING',?,'now')",
        [item.id, item.providerId, item.eventAt, item.kind, JSON.stringify(item)],
      );
      return { id: item.id, kind: item.kind, eventAt: item.eventAt, state: 'PENDING', item };
    };
    // 2. One-time repair to the verified post-event balance.
    const topup = await stage(evidence({}));
    await review.approve(topup, wallet.id, 880000, 'Meal wallet top-up');
    expect(balance().balanceMinor).toBe(973724);
    // 3–5. Editing, moving or deleting earlier history keeps the trusted anchor.
    const historyA = store.transactions().find((entry) => entry.id === 'history-a')!;
    store.updateTransaction({ ...historyA, amountMinor: 120000 });
    await settle();
    expect(balance().balanceMinor).toBe(973724);
    const historyB = store.transactions().find((entry) => entry.id === 'history-b')!;
    store.updateTransaction({ ...historyB, amountMinor: 6000, transactionTime: '04:30:00' });
    await settle();
    expect(balance().balanceMinor).toBe(973724);
    store.deleteTransaction('history-a');
    await settle();
    expect(balance().balanceMinor).toBe(973724);
    expect(storedBalance()).toBe(973724);
    expect(rows("SELECT id FROM card_transactions WHERE id='history-b'")).toHaveLength(1);
    // 6. Activity after the anchor applies and reverses normally.
    const purchase = await stage(
      evidence({
        id: 'b'.repeat(64),
        kind: 'PLUXEE_PURCHASE',
        amountMinor: 50000,
        eventTime: '06:00:00',
        eventAt: '2026-10-23T00:30:00Z',
        reportedBalanceMinor: undefined,
      }),
    );
    await review.approve(purchase, wallet.id, 50000, 'Fictional breakfast');
    expect(balance().balanceMinor).toBe(923724);
    store.addTransaction({
      ...base,
      id: 'after-anchor',
      amountMinor: 25000,
      transactionDate: '2026-10-23',
      transactionTime: '07:00:00',
    });
    await settle();
    expect(balance().balanceMinor).toBe(898724);
    store.updateTransaction({
      ...store.transactions().find((entry) => entry.id === 'after-anchor')!,
      amountMinor: 20000,
    });
    await settle();
    expect(balance().balanceMinor).toBe(903724);
    store.deleteTransaction('after-anchor');
    await settle();
    expect(balance().balanceMinor).toBe(923724);
    // 7. The reconciled top-up itself edits and reverses symmetrically.
    const topupEntry = () => store.transactions().find((entry) => entry.id === `sms-${topup.id}`)!;
    store.updateTransaction({ ...topupEntry(), amountMinor: 870000 });
    await settle();
    expect(balance().balanceMinor).toBe(913724);
    store.updateTransaction({ ...topupEntry(), amountMinor: 880000 });
    await settle();
    expect(balance().balanceMinor).toBe(923724);
    // 8. Source transfers: later activity leaves once; earlier history never shifts the anchor.
    const smsPurchase = store.transactions().find((entry) => entry.id === `sms-${purchase.id}`)!;
    store.updateTransaction({ ...smsPurchase, cardId: 'source-cash' });
    await settle();
    expect(balance().balanceMinor).toBe(973724);
    const movedB = store.transactions().find((entry) => entry.id === 'history-b')!;
    store.updateTransaction({ ...movedB, cardId: 'source-cash' });
    await settle();
    store.updateTransaction({
      ...store.transactions().find((entry) => entry.id === 'history-b')!,
      cardId: wallet.id,
    });
    await settle();
    expect(balance().balanceMinor).toBe(973724);
    store.updateTransaction({
      ...store.transactions().find((entry) => entry.id === smsPurchase.id)!,
      cardId: wallet.id,
    });
    await settle();
    expect(balance().balanceMinor).toBe(923724);
    // Explicit historical application cannot double-count an event the anchor already contains.
    const earlier = await stage(
      evidence({
        id: 'c'.repeat(64),
        kind: 'PLUXEE_PURCHASE',
        amountMinor: 1200,
        eventDate: '2026-10-22',
        eventTime: '12:00:00',
        eventAt: '2026-10-22T06:30:00Z',
        reportedBalanceMinor: undefined,
      }),
    );
    await expect(
      review.approve(earlier, wallet.id, 1200, 'Earlier purchase', '', 'APPLY_EVENT'),
    ).rejects.toThrow('already includes');
    expect(balance().balanceMinor).toBe(923724);
    await review.approve(earlier, wallet.id, 1200, 'Earlier purchase', '', 'RETAIN_BALANCE');
    expect(balance().balanceMinor).toBe(923724);
    // A later explicit correction is audited without overwriting the one-time repair marker.
    const later = await stage(
      evidence({
        id: 'd'.repeat(64),
        amountMinor: 10000,
        eventDate: '2026-10-24',
        eventTime: '06:00:00',
        eventAt: '2026-10-24T00:30:00Z',
        reportedBalanceMinor: 930000,
      }),
    );
    await review.approve(later, wallet.id, 10000, 'Later load', '', 'ADJUST_BALANCE');
    expect(balance()).toMatchObject({
      balanceMinor: 930000,
      balanceCutoverAt: '2026-10-24T00:30:00Z',
      balanceReconciliation: { candidateId: topup.id, correctionMinor: -239400 },
      latestBalanceReconciliation: {
        candidateId: later.id,
        transactionId: `sms-${later.id}`,
        savedBalanceMinor: 923724,
        predictedBalanceMinor: 933724,
        correctionMinor: -3724,
      },
    });
    expect(
      String(
        rows('SELECT decision FROM sms_reconciliation WHERE candidate_id=?', [later.id])[0][
          'decision'
        ],
      ),
    ).toContain('EXPLICIT_BALANCE_RECONCILIATION');
    // The new anchor now contains the earlier top-up; editing it no longer shifts funds.
    store.updateTransaction({ ...topupEntry(), amountMinor: 870000 });
    await settle();
    expect(balance().balanceMinor).toBe(930000);
    const stale = await stage(
      evidence({
        id: 'e'.repeat(64),
        amountMinor: 20000,
        eventTime: '08:00:00',
        eventAt: '2026-10-23T02:30:00Z',
        reportedBalanceMinor: 5000000,
      }),
    );
    await expect(
      review.approve(stale, wallet.id, 20000, 'Stale load', '', 'ADJUST_BALANCE'),
    ).rejects.toThrow();
    expect(balance().balanceMinor).toBe(930000);
    expect(storedBalance()).toBe(930000);
    expect(store.paymentSources().filter((source) => source.id !== wallet.id)).toEqual(
      otherSources,
    );
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(restarted.paymentSources().find((source) => source.id === wallet.id)).toEqual(balance());
  });
  it('starts signals empty and initializes a genuinely fresh production database without fictional financial values', async () => {
    const store = TestBed.inject(CardNestStore);
    expect(store.cards()).toEqual([]);
    expect(store.transactions()).toEqual([]);
    expect(store.monthlyIncomeMinor()).toBe(0);
    expect(store.monthlyBudgetMinor()).toBe(0);
    await database.initialise();
    expect(marker()).toBe('PENDING');
    await store.initialisePreferences();
    expect(marker()).toBe('EMPTY');
    expect(count('credit_cards')).toBe(0);
    expect(count('card_transactions')).toBe(0);
    expect(count('monthly_income')).toBe(0);
    expect(count('categories')).toBeGreaterThan(0);
    expect(store.paymentSources().every((source) => !source.balanceMinor)).toBe(true);
  });
  it('turning demo on in a later build cannot populate an already initialized empty installation', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    config.seedDemoData = true;
    await database.initialise();
    await store.initialisePreferences();
    expect(marker()).toBe('EMPTY');
    expect(store.cards()).toEqual([]);
    expect(count('card_transactions')).toBe(0);
    expect(count('monthly_income')).toBe(0);
  });
  it('does not seed a schema-only interrupted version-zero installation', async () => {
    schema(7);
    sql.exec('PRAGMA user_version=0');
    config.seedDemoData = true;
    await database.initialise();
    await TestBed.inject(CardNestStore).initialisePreferences();
    expect(marker()).toBe('EXISTING');
    expect(count('credit_cards')).toBe(0);
    expect(count('monthly_income')).toBe(0);
  });
  it('demo-enabled fresh initialization seeds a coherent labeled dataset once, and flag changes preserve it', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(marker()).toBe('DEMO');
    expect(count('credit_cards')).toBe(2);
    expect(count('card_transactions')).toBe(4);
    expect(count('monthly_income')).toBe(1);
    expect(store.cards().every((card) => card.nickname.includes('(demo)'))).toBe(true);
    expect(store.monthlyBudgetMinor()).toBe(6000000);
    expect(store.monthlyIncomeMinor()).toBe(8000000);
    const before = rows('SELECT * FROM card_transactions');
    config.seedDemoData = false;
    await store.initialisePreferences();
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
    expect(count('credit_cards')).toBe(2);
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('concurrent eligible initialization cannot duplicate demo records', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await Promise.all([store.initialisePreferences(), store.initialisePreferences()]);
    expect(count('credit_cards')).toBe(2);
    expect(count('card_transactions')).toBe(4);
    expect(count('monthly_income')).toBe(1);
  });
  it('preserves legacy cached records with existing sources but never lets stale cache override an empty restore', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const cached = { ...store.transactions()[0], id: 'synthetic-legacy-cache' };
    localStorage.setItem('cardnest.transactions.cache.v1', JSON.stringify([cached]));
    await database.run('DELETE FROM card_transactions');
    await database.run(
      "UPDATE app_preferences SET encrypted_value='EXISTING' WHERE key='initial_data_state'",
    );
    config.seedDemoData = false;
    await store.initialisePreferences();
    expect(store.transactions()).toEqual([cached]);
    const backup = await database.exportBackupJson();
    await database.restoreBackupJson(backup);
    await store.initialisePreferences();
    expect(store.transactions()).toEqual([]);
    expect(count('credit_cards')).toBe(2);
    localStorage.removeItem('cardnest.transactions.cache.v1');
  });
  it('does not remove existing demo transactions when a user adds their first manual transaction', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    store.addTransaction({
      ...store.transactions()[0],
      id: 'synthetic-manual',
      merchant: 'Synthetic manual',
    });
    await database.atomic(async () => undefined);
    expect(store.transactions()).toHaveLength(5);
    expect(count('card_transactions')).toBe(5);
  });
  it('never seeds an existing empty versioned database, nor after cards are manually removed', async () => {
    schema(7);
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(marker()).toBe('EXISTING');
    expect(count('credit_cards')).toBe(0);
    expect(count('monthly_income')).toBe(0);
    await store.initialisePreferences();
    expect(store.cards()).toEqual([]);
    expect(store.transactions()).toEqual([]);
  });
  it('does not seed a partially initialized version-zero database with existing preferences', async () => {
    schema(7);
    sql.exec(
      "PRAGMA user_version=0; INSERT INTO app_preferences VALUES('profile_name','Synthetic existing')",
    );
    // Replayable old schema statements coexist with the interrupted database.
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(marker()).toBe('EXISTING');
    expect(count('credit_cards')).toBe(0);
    expect(store.profileName()).toBe('Synthetic existing');
  });
  it('adds read flags without changing financial rows, decisions, bindings or wallet amounts', async () => {
    schema(7);
    installFinancialData();
    const before = {
      cards: rows('SELECT * FROM credit_cards'),
      ledger: rows('SELECT * FROM card_transactions'),
      loans: rows('SELECT * FROM loan_commitments'),
      binding: rows('SELECT * FROM sms_reconciliation'),
      wallet: rows("SELECT * FROM app_preferences WHERE key='payment_sources'"),
    };
    await database.initialise();
    expect({
      cards: rows('SELECT * FROM credit_cards'),
      ledger: rows('SELECT * FROM card_transactions'),
      loans: rows('SELECT * FROM loan_commitments'),
      binding: rows('SELECT * FROM sms_reconciliation'),
      wallet: rows("SELECT * FROM app_preferences WHERE key='payment_sources'"),
    }).toEqual(before);
    expect(rows('SELECT id,state,read_at FROM sms_candidates ORDER BY id')).toEqual([
      { id: 'synthetic-pending', state: 'PENDING', read_at: null },
      { id: 'synthetic-read', state: 'IMPORTED', read_at: 'before' },
    ]);
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('round trips read flags and bindings through real backup/restore while excluding evidence payloads and blocking reseeding', async () => {
    schema(7);
    installFinancialData();
    await database.initialise();
    const backup = await database.exportBackupJson();
    expect(backup).not.toContain('Synthetic private evidence');
    expect(backup).not.toContain('Synthetic pending evidence');
    await database.run("UPDATE sms_candidates SET read_at='changed'");
    await database.restoreBackupJson(backup);
    expect(marker()).toBe('RESTORED');
    expect(rows('SELECT id,read_at,payload FROM sms_candidates ORDER BY id')).toEqual([
      { id: 'synthetic-pending', read_at: null, payload: null },
      { id: 'synthetic-read', read_at: 'before', payload: null },
    ]);
    const before = rows('SELECT * FROM card_transactions');
    config.seedDemoData = true;
    // Initialization must return without touching restored financial rows.
    const { initialiseAppData } = await import('./app-initialization');
    await initialiseAppData(database, true, {
      categories: [],
      cards: [],
      transactions: [],
      income: {
        periodKey: 'synthetic',
        cycleStartDate: '2026-01-01',
        cycleEndDate: '2026-01-31',
        amountMinor: 1,
        updatedAt: 'now',
      },
    });
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
    expect(count('sms_reconciliation')).toBe(1);
  });
  it.each([
    { kind: 'REFUND', search: 'Synthetic legacy' },
    {
      kind: 'PURCHASE',
      mode: 'MULTIPLE',
      kinds: ['PURCHASE', 'CASHBACK', 'PURCHASE', 'invalid'],
      multipleInitialized: true,
      read: 'READ',
    },
    { mode: 'MULTIPLE', kinds: [], multipleInitialized: true },
  ])(
    'round trips old/new SMS filter preferences and matching audit without financial changes %j',
    async (preferences) => {
      schema(7);
      installFinancialData();
      await database.initialise();
      await database.run('INSERT INTO app_preferences VALUES(?,?)', [
        'sms_review_filters',
        JSON.stringify(preferences),
      ]);
      const before = rows('SELECT * FROM card_transactions');
      const backup = await database.exportBackupJson();
      await database.restoreBackupJson(backup);
      const restored = JSON.parse(
        String(
          rows("SELECT encrypted_value FROM app_preferences WHERE key='sms_review_filters'")[0][
            'encrypted_value'
          ],
        ),
      );
      expect(reviewFilters(restored)).toEqual(reviewFilters(preferences));
      expect(rows('SELECT * FROM card_transactions')).toEqual(before);
      expect(rows('SELECT target_id FROM sms_reconciliation')[0]['target_id']).toBe(
        'synthetic-transaction',
      );
    },
  );
  it('read state survives closing and reopening an on-disk SQLite database', async () => {
    schema(7);
    installFinancialData();
    await database.initialise();
    await database.run(
      "UPDATE sms_candidates SET read_at='synthetic-seen' WHERE id='synthetic-pending'",
    );
    const directory = mkdtempSync(join(tmpdir(), 'card-nest-read-restart-'));
    const file = join(directory, `synthetic-read-restart-${randomUUID()}.sqlite`);
    await database.run('INSERT INTO app_preferences VALUES(?,?)', [
      'sms_review_filters',
      JSON.stringify({ search: 'Synthetic saved query', read: 'ALL' }),
    ]);
    try {
      sql.prepare('VACUUM INTO ?').run(file);
      sql.close();
      sql = new DatabaseSync(file);
      await database.initialise();
      expect(rows("SELECT read_at,state FROM sms_candidates WHERE id='synthetic-pending'")).toEqual(
        [{ read_at: 'synthetic-seen', state: 'PENDING' }],
      );
      expect(count('card_transactions')).toBe(1);
      expect(
        JSON.parse(
          String(
            rows("SELECT encrypted_value FROM app_preferences WHERE key='sms_review_filters'")[0][
              'encrypted_value'
            ],
          ),
        ),
      ).toEqual({ search: 'Synthetic saved query', read: 'ALL' });
    } finally {
      sql.close();
      sql = new DatabaseSync(':memory:');
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
    }
  });
  it('restores old backups without read fields using the migration policy and never seeds an empty restored backup', async () => {
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const backup = JSON.parse(await database.exportBackupJson()) as {
      tables: { name: string; rows: Record<string, unknown>[] }[];
    };
    const candidates = backup.tables.find((table) => table.name === 'sms_candidates')!;
    candidates.rows = [
      {
        id: 'synthetic-old',
        provider_id: '1',
        event_at: '2026-01-01',
        kind: 'PURCHASE',
        state: 'REJECTED',
        payload: null,
        updated_at: 'before',
      },
    ];
    await database.restoreBackupJson(JSON.stringify(backup));
    expect(rows('SELECT read_at FROM sms_candidates')).toEqual([{ read_at: 'before' }]);
    candidates.rows = [];
    await database.restoreBackupJson(JSON.stringify(backup));
    config.seedDemoData = true;
    await store.initialisePreferences();
    expect(count('credit_cards')).toBe(0);
    expect(count('card_transactions')).toBe(0);
    expect(marker()).toBe('RESTORED');
  });
  it('explicit Delete all data leaves a durable no-reseed marker even in a demo-enabled build', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    await store.deleteAllData();
    expect(marker()).toBe('CLEARED');
    await database.initialise();
    await store.initialisePreferences();
    expect(count('credit_cards')).toBe(0);
    expect(count('card_transactions')).toBe(0);
    expect(count('monthly_income')).toBe(0);
    expect(store.cards()).toEqual([]);
  });
  it('seed failures roll back cards, transactions, categories and marker together, and retry does not duplicate data', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    sql.exec(
      "CREATE TRIGGER fail_seed BEFORE INSERT ON card_transactions BEGIN SELECT RAISE(ABORT,'synthetic seed failure'); END",
    );
    await expect(store.initialisePreferences()).rejects.toThrow('synthetic seed failure');
    expect(count('credit_cards')).toBe(0);
    expect(count('categories')).toBe(0);
    expect(marker()).toBe('PENDING');
    sql.exec('DROP TRIGGER fail_seed');
    await store.initialisePreferences();
    await store.initialisePreferences();
    expect(count('credit_cards')).toBe(2);
    expect(count('card_transactions')).toBe(4);
  });
  it('a pending first-run marker cannot seed demos after the user has created financial data', async () => {
    config.seedDemoData = true;
    await database.initialise();
    const card = {
      id: 'synthetic-user-card',
      nickname: 'Synthetic user-created card',
      issuerName: 'Fictional Bank',
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
      createdAt: '2026-10-01',
      updatedAt: '2026-10-01',
    };
    await database.run(
      'INSERT INTO credit_cards(id,nickname,issuer_name,last_digits,network,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      [
        card.id,
        card.nickname,
        card.issuerName,
        card.lastDigits,
        card.network,
        JSON.stringify(card),
        card.createdAt,
        card.updatedAt,
      ],
    );
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    expect(marker()).toBe('EXISTING');
    expect(store.cards().map((item) => item.id)).toEqual([card.id]);
    expect(count('card_transactions')).toBe(0);
    expect(count('monthly_income')).toBe(0);
    expect(store.monthlyBudgetMinor()).toBe(0);
  });
  it('failed restore rolls back read flags and financial data as one transaction', async () => {
    schema(7);
    installFinancialData();
    await database.initialise();
    const backup = await database.exportBackupJson();
    const before = rows('SELECT * FROM sms_candidates');
    sql.exec(
      "CREATE TRIGGER fail_restore BEFORE INSERT ON sms_candidates BEGIN SELECT RAISE(ABORT,'synthetic restore failure'); END",
    );
    await expect(database.restoreBackupJson(backup)).rejects.toThrow('synthetic restore failure');
    expect(rows('SELECT * FROM sms_candidates')).toEqual(before);
    expect(count('card_transactions')).toBe(1);
    expect(count('sms_reconciliation')).toBe(1);
  });
  it('reopens and migrates a legacy plugin import before recording RESTORED, without introducing demo data', async () => {
    await database.initialise();
    vi.mocked(CapacitorSQLite.isJsonValid).mockResolvedValue({ result: true });
    // The platform importer is the boundary stub; its resulting old-version database is real SQLite.
    vi.mocked(CapacitorSQLite.importFromJson).mockImplementation(async () => {
      sql.close();
      sql = new DatabaseSync(':memory:');
      sql.exec('PRAGMA foreign_keys=ON');
      schema(7);
      installFinancialData();
      return { changes: { changes: 1 } };
    });
    await database.restoreBackupJson(
      JSON.stringify({ database: 'synthetic-legacy', version: 7, tables: [] }),
    );
    expect(database.ready()).toBe(true);
    expect(marker()).toBe('RESTORED');
    expect(count('credit_cards')).toBe(1);
    expect(count('card_transactions')).toBe(1);
    expect(rows("SELECT read_at FROM sms_candidates WHERE id='synthetic-read'")).toEqual([
      { read_at: 'before' },
    ]);
    expect(vi.mocked(CapacitorSQLite.closeConnection)).toHaveBeenCalled();
    expect(CapacitorSQLite.createConnection).toHaveBeenCalledTimes(2);
    expect(sql.prepare('PRAGMA user_version').get()?.['user_version']).toBe(9);
  });
});
