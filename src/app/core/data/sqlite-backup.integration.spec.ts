import { TestBed } from '@angular/core/testing';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { SqliteDatabase } from './sqlite-database';
import { DATABASE_MIGRATIONS } from './migrations';
import { CardNestStore } from '../services/card-nest-store';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { APP_ENVIRONMENT } from '../services/app-environment';

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
      providers: [SqliteDatabase, CardNestStore, { provide: APP_ENVIRONMENT, useValue: config }],
    });
    database = TestBed.inject(SqliteDatabase);
  });
  afterEach(() => {
    sql.close();
    vi.restoreAllMocks();
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
  it('read state survives closing and reopening an on-disk SQLite database', async () => {
    schema(7);
    installFinancialData();
    await database.initialise();
    await database.run(
      "UPDATE sms_candidates SET read_at='synthetic-seen' WHERE id='synthetic-pending'",
    );
    const file = resolve('tmp', `synthetic-read-restart-${randomUUID()}.sqlite`);
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
      if (existsSync(file)) unlinkSync(file);
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
    expect(sql.prepare('PRAGMA user_version').get()?.['user_version']).toBe(8);
  });
});
