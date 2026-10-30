import { TestBed } from '@angular/core/testing';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
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
import {
  defaultReviewFilters,
  reviewFilters,
  SMS_REVIEW_FILTERS_KEY,
} from '../../features/sms-sync/sms-review-filters';
import { BackupService } from '../services/backup.service';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { NATIVE_EXPORT } from '../services/native-export';
import { AppLockService } from '../services/app-lock.service';
import { SmsReviewService } from '../../features/sms-sync/sms-review.service';
import { SmsCandidate, SmsEvidence } from '../../features/sms-sync/sms-model';
import { indiaTodayIso } from '../services/india-date';
import {
  UtilitiesService,
  SHOW_INDIAN_UTILITIES_KEY,
  UTILITY_REMINDERS_KEY,
} from '../../features/utilities/utilities.service';
import { BankActivityService } from '../../features/bank-activity/bank-activity.service';
import { addCalendarDays } from '../../features/utilities/utilities-calculations';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

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
  let sql: DatabaseSyncType;
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

  it.each([false, true])(
    'atomically deletes a mobile profile and its recharges (archived=%s) without touching other data',
    async (archived) => {
      await database.initialise();
      const store = TestBed.inject(CardNestStore);
      await store.initialisePreferences();
      const utilities = TestBed.inject(UtilitiesService);
      await utilities.initialise();
      const profile = await utilities.saveMobileProfile({
        personName: 'Deletion target',
        subscriptionType: 'PREPAID',
        operator: 'JIO',
      });
      const other = await utilities.saveMobileProfile({
        personName: 'Keep mobile',
        subscriptionType: 'POSTPAID',
        operator: 'AIRTEL',
      });
      for (const profileId of [profile.id, profile.id, other.id])
        await utilities.saveRecharge({
          profileId,
          planType: 'VOICE_DATA',
          startDate: '2026-10-01',
          validityDays: 30,
        });
      const lpg = await utilities.saveLpgProfile({
        connectionName: 'Keep LPG',
        provider: 'INDANE',
        commercial: false,
        cylinderSize: 'NORMAL',
        estimatedUsageDays: 25,
      });
      await utilities.saveLpgEvent({
        profileId: lpg.id,
        eventType: 'STARTED',
        eventDate: '2026-10-01',
      });
      await store.addBankAccount({
        nickname: 'Keep bank',
        institution: 'Synthetic Bank',
        lastDigits: '007',
      });
      await store.saveManualTransaction({
        id: 'keep-c1-purchase',
        cardId: 'source-cash',
        type: 'PURCHASE',
        amountMinor: 12345,
        currencyCode: 'INR',
        transactionDate: indiaTodayIso(),
        categoryId: 'other',
        attachmentIds: [],
        createdAt: '2026-10-01T12:00:00Z',
        updatedAt: '2026-10-01T12:00:00Z',
      });
      await database.run(
        "INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES('keep-c1-sms','synthetic','2026-10-01','BANK_DEBIT','PENDING','{}','before')",
      );
      const savedRecharges = utilities.rechargesFor(profile.id);
      const financialTables = [
        'credit_cards',
        'card_transactions',
        'sms_candidates',
        'sms_reconciliation',
        'source_transfers',
        'source_balance_adjustments',
        'transaction_split_groups',
        'transaction_split_members',
        'loan_commitments',
        'emi_plans',
        'emi_installments',
        'recurring_rules',
        'bank_activity_profiles',
        'bank_activity_events',
      ];
      const financialState = () =>
        financialTables.map((table) => rows(`SELECT * FROM ${table} ORDER BY rowid`));
      const unchanged = financialState();
      const restoredFinancialState = unchanged.map((records, index) =>
        financialTables[index] === 'sms_candidates'
          ? records.map((record) => ({ ...record, payload: null }))
          : records,
      );
      const sources = rows("SELECT * FROM app_preferences WHERE key='payment_sources'");
      await utilities.setMobileArchived(profile.id, true);
      await utilities.setMobileArchived(profile.id, false);
      expect(utilities.rechargesFor(profile.id)).toHaveLength(2);
      if (archived) await utilities.setMobileArchived(profile.id, true);
      const beforeProfiles = utilities.mobileProfiles();
      const beforeRecharges = utilities.mobileRecharges();
      sql.exec(
        "CREATE TRIGGER fail_mobile_delete BEFORE DELETE ON utility_profiles WHEN OLD.kind='MOBILE' BEGIN SELECT RAISE(ABORT,'mobile delete rollback'); END",
      );
      await expect(utilities.deleteMobileProfile(profile.id)).rejects.toThrow(
        'mobile delete rollback',
      );
      expect(utilities.mobileProfiles()).toBe(beforeProfiles);
      expect(utilities.mobileRecharges()).toBe(beforeRecharges);
      expect(count('mobile_recharges')).toBe(3);
      expect(count('utility_profiles')).toBe(3);
      sql.exec('DROP TRIGGER fail_mobile_delete');
      await expect(utilities.deleteMobileProfile(lpg.id)).rejects.toThrow(
        'Mobile profile not found',
      );

      vi.stubGlobal('crypto', webcrypto);
      vi.stubGlobal('Blob', NodeBlob);
      try {
        const backups = TestBed.inject(BackupService);
        const before = await backups.create('synthetic-mobile-deletion-passphrase');
        const refresh = vi
          .spyOn(utilities, 'reload')
          .mockRejectedValue(new Error('Post-commit refresh unavailable'));
        const atomic = database.atomic.bind(database);
        const publishedBeforeCommit: boolean[] = [];
        const transaction = vi.spyOn(database, 'atomic').mockImplementation((work) =>
          atomic(async (tx) => {
            const result = await work(tx);
            publishedBeforeCommit.push(
              utilities.mobileProfiles().some((row) => row.id === profile.id),
            );
            return result;
          }),
        );
        await utilities.deleteMobileProfile(profile.id);
        expect(publishedBeforeCommit).toEqual([true]);
        transaction.mockRestore();
        expect(refresh).not.toHaveBeenCalled();
        refresh.mockRestore();
        expect(utilities.mobileProfiles().map((row) => row.id)).toEqual([other.id]);
        expect(utilities.rechargesFor(profile.id)).toEqual([]);
        expect(utilities.rechargesFor(other.id)).toHaveLength(1);
        expect(count('lpg_events')).toBe(1);
        expect(financialState()).toEqual(unchanged);
        expect(rows("SELECT * FROM app_preferences WHERE key='payment_sources'")).toEqual(sources);
        const after = await backups.create('synthetic-mobile-deletion-passphrase');
        const restarted = TestBed.runInInjectionContext(() => new UtilitiesService());
        await restarted.initialise();
        expect(restarted.mobileProfiles().map((row) => row.id)).toEqual([other.id]);
        await backups.restore(before.contents, 'synthetic-mobile-deletion-passphrase');
        await restarted.initialise();
        expect(restarted.rechargesFor(profile.id)).toHaveLength(2);
        expect(restarted.rechargesFor(profile.id)).toEqual(
          expect.arrayContaining([...savedRecharges]),
        );
        expect(restarted.mobileProfiles().find((row) => row.id === profile.id)?.archived).toBe(
          archived,
        );
        expect(financialState()).toEqual(restoredFinancialState);
        await backups.restore(after.contents, 'synthetic-mobile-deletion-passphrase');
        await restarted.initialise();
        expect(restarted.mobileProfiles().map((row) => row.id)).toEqual([other.id]);
        expect(restarted.rechargesFor(other.id)).toHaveLength(1);
        expect(restarted.lpgEvents()).toHaveLength(1);
        expect(financialState()).toEqual(restoredFinancialState);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('deletes only an individually selected recharge and retains its sibling and profile after restart', async () => {
    await database.initialise();
    const utilities = TestBed.inject(UtilitiesService);
    await utilities.initialise();
    const profile = await utilities.saveMobileProfile({
      personName: 'Keep history',
      operator: 'JIO',
      subscriptionType: 'PREPAID',
    });
    const first = await utilities.saveRecharge({
      profileId: profile.id,
      planType: 'VOICE_ONLY',
      startDate: '2026-09-01',
      validityDays: 30,
    });
    const second = await utilities.saveRecharge({
      profileId: profile.id,
      planType: 'DATA_ONLY',
      startDate: '2026-10-01',
      validityDays: 30,
      comment: 'Retain sibling',
    });
    await utilities.deleteRecharge(first.id);
    const restarted = TestBed.runInInjectionContext(() => new UtilitiesService());
    await restarted.initialise();
    expect(restarted.rechargesFor(profile.id)).toEqual([second]);
    expect(restarted.mobileProfiles().map((row) => row.id)).toEqual([profile.id]);
    await utilities.deleteMobileProfile(profile.id);
    const empty = await utilities.saveMobileProfile({
      personName: 'No recharge history',
      operator: 'VI',
      subscriptionType: 'POSTPAID',
    });
    await utilities.deleteMobileProfile(empty.id);
    expect(count('utility_profiles')).toBe(0);
  });

  it('serializes LPG progression and rejects duplicate, backdated, edited and deleted-event conflicts', async () => {
    await database.initialise();
    const utilities = TestBed.inject(UtilitiesService);
    await utilities.initialise();
    const profile = await utilities.saveLpgProfile({
      connectionName: 'Lifecycle connection',
      provider: 'INDANE',
      commercial: false,
      cylinderSize: 'NORMAL',
      estimatedUsageDays: 25,
    });
    const save = (eventType: 'STARTED' | 'EMPTY' | 'REFILL_RECEIVED', eventDate = '2026-10-02') =>
      utilities.saveLpgEvent({ profileId: profile.id, eventType, eventDate });
    await expect(save('EMPTY')).rejects.toThrow('preceding cylinder STARTED');
    const concurrent = await Promise.allSettled([save('STARTED'), save('STARTED')]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const started = utilities.eventsFor(profile.id)[0];
    await expect(save('REFILL_RECEIVED')).rejects.toThrow('in use');
    const empty = await save('EMPTY');
    await expect(save('EMPTY')).rejects.toThrow('preceding cylinder STARTED');
    const received = await save('REFILL_RECEIVED');
    await expect(save('REFILL_RECEIVED')).rejects.toThrow('already recorded');
    expect(utilities.eventsFor(profile.id)).toHaveLength(3);
    await save('STARTED', '2026-10-03');
    const snapshot = rows('SELECT * FROM lpg_events ORDER BY rowid');
    await expect(save('STARTED', '2026-10-01')).rejects.toThrow('2026-10-02');
    await expect(utilities.saveLpgEvent({ ...started, eventDate: '2026-10-04' })).rejects.toThrow();
    await expect(utilities.deleteLpgEvent(started.id)).rejects.toThrow('EMPTY requires');
    await expect(utilities.deleteLpgEvent(empty.id)).rejects.toThrow();
    await expect(
      utilities.saveLpgEvent({
        profileId: profile.id,
        eventType: 'UNKNOWN' as 'STARTED',
        eventDate: '2026-10-04',
      }),
    ).rejects.toThrow('Choose a cylinder event');
    await expect(
      utilities.saveLpgEvent({
        profileId: profile.id,
        eventType: 'EMPTY',
        cylinderSize: 'UNKNOWN' as 'NORMAL',
        eventDate: '2026-10-04',
      }),
    ).rejects.toThrow('supported cylinder size');
    expect(rows('SELECT * FROM lpg_events ORDER BY rowid')).toEqual(snapshot);
    const edited = await utilities.saveLpgEvent({
      ...received,
      comment: 'Receipt correction',
      amountMinor: 95000,
    });
    expect(edited.id).toBe(received.id);
    expect(edited.createdAt).toBe(received.createdAt);
    sql.exec(
      "CREATE TRIGGER fail_lpg_event BEFORE INSERT ON lpg_events BEGIN SELECT RAISE(ABORT,'event write rollback'); END",
    );
    const signals = utilities.lpgEvents();
    await expect(save('EMPTY', '2026-10-04')).rejects.toThrow('event write rollback');
    expect(utilities.lpgEvents()).toBe(signals);
    expect(count('lpg_events')).toBe(4);
    sql.exec('DROP TRIGGER fail_lpg_event');
    await utilities.reload();
    expect(utilities.eventsFor(profile.id).map((event) => event.eventType)).toEqual([
      'STARTED',
      'EMPTY',
      'REFILL_RECEIVED',
      'STARTED',
    ]);
    await save('EMPTY', '2026-10-04');
    await save('STARTED', '2026-10-05');
    sql.exec(
      "CREATE TRIGGER fail_lpg_event_delete BEFORE DELETE ON lpg_events BEGIN SELECT RAISE(ABORT,'event delete rollback'); END",
    );
    const beforeDelete = utilities.lpgEvents();
    await expect(utilities.deleteLpgEvent(received.id)).rejects.toThrow('event delete rollback');
    expect(utilities.lpgEvents()).toBe(beforeDelete);
    expect(count('lpg_events')).toBe(6);
    sql.exec('DROP TRIGGER fail_lpg_event_delete');
    await utilities.deleteLpgEvent(received.id);
    expect(utilities.eventsFor(profile.id)).toHaveLength(5);
  });

  it('retains row order for same-day LPG events with identical creation timestamps after restart', async () => {
    await database.initialise();
    const utilities = TestBed.inject(UtilitiesService);
    await utilities.initialise();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    try {
      const profile = await utilities.saveLpgProfile({
        connectionName: 'Same-day connection',
        provider: 'INDANE',
        commercial: false,
        cylinderSize: 'NORMAL',
        estimatedUsageDays: 25,
      });
      for (const eventType of ['STARTED', 'EMPTY', 'REFILL_RECEIVED', 'STARTED'] as const)
        await utilities.saveLpgEvent({ profileId: profile.id, eventType, eventDate: '2026-10-10' });
      expect(new Set(utilities.eventsFor(profile.id).map((event) => event.createdAt)).size).toBe(1);
      await utilities.saveLpgEvent({
        ...utilities.eventsFor(profile.id)[1],
        comment: 'Same-day correction',
      });
      const restarted = TestBed.runInInjectionContext(() => new UtilitiesService());
      await restarted.initialise();
      expect(restarted.eventsFor(profile.id).map((event) => event.eventType)).toEqual([
        'STARTED',
        'EMPTY',
        'REFILL_RECEIVED',
        'STARTED',
      ]);
      await restarted.saveLpgEvent({
        profileId: profile.id,
        eventType: 'EMPTY',
        eventDate: '2026-10-10',
      });
      expect(restarted.eventsFor(profile.id)).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves legacy LPG conflicts and permits safe explicit corrections without rewriting later records', async () => {
    await database.initialise();
    const utilities = TestBed.inject(UtilitiesService);
    await utilities.initialise();
    const profile = await utilities.saveLpgProfile({
      connectionName: 'Legacy connection',
      provider: 'HPCL',
      commercial: true,
      cylinderSize: 'SMALL',
      estimatedUsageDays: 25,
    });
    const legacy = {
      id: 'legacy-empty',
      profileId: profile.id,
      eventType: 'EMPTY' as const,
      eventDate: '2026-10-01',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: 'before',
    };
    await database.run(
      'INSERT INTO lpg_events(id,profile_id,event_type,event_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      [
        legacy.id,
        profile.id,
        legacy.eventType,
        legacy.eventDate,
        JSON.stringify(legacy),
        legacy.createdAt,
        legacy.updatedAt,
      ],
    );
    await utilities.reload();
    expect(utilities.eventsFor(profile.id)).toEqual([legacy]);
    await utilities.saveLpgEvent({ ...legacy, comment: 'Explicit historical note' });
    const started = await utilities.saveLpgEvent({
      profileId: profile.id,
      eventType: 'STARTED',
      eventDate: '2026-10-02',
    });
    await expect(utilities.saveLpgEvent({ ...legacy, eventType: 'STARTED' })).rejects.toThrow(
      '2026-10-02',
    );
    await utilities.deleteLpgEvent(legacy.id);
    expect(utilities.eventsFor(profile.id)).toEqual([started]);
  });

  it.each([false, true])(
    'atomically deletes only the selected LPG connection and round trips backups (archived=%s)',
    async (archived) => {
      await database.initialise();
      const store = TestBed.inject(CardNestStore);
      await store.initialisePreferences();
      const utilities = TestBed.inject(UtilitiesService);
      await utilities.initialise();
      const connection = await utilities.saveLpgProfile({
        connectionName: 'Delete LPG',
        provider: 'INDANE',
        commercial: true,
        cylinderSize: 'NORMAL',
        estimatedUsageDays: 25,
      });
      const other = await utilities.saveLpgProfile({
        connectionName: 'Keep LPG',
        provider: 'HPCL',
        commercial: false,
        cylinderSize: 'SMALL',
        estimatedUsageDays: 25,
      });
      for (const profileId of [connection.id, other.id]) {
        await utilities.saveLpgEvent({ profileId, eventType: 'STARTED', eventDate: '2026-10-01' });
        await utilities.saveLpgEvent({ profileId, eventType: 'EMPTY', eventDate: '2026-10-20' });
      }
      const mobile = await utilities.saveMobileProfile({
        personName: 'Keep mobile',
        operator: 'JIO',
        subscriptionType: 'PREPAID',
      });
      await utilities.saveRecharge({
        profileId: mobile.id,
        planType: 'VOICE_DATA',
        startDate: '2026-10-01',
        validityDays: 30,
      });
      await store.addBankAccount({
        nickname: 'Keep bank',
        institution: 'Synthetic Bank',
        lastDigits: '007',
      });
      await store.saveManualTransaction({
        id: 'keep-c2-purchase',
        cardId: 'source-cash',
        type: 'PURCHASE',
        amountMinor: 12345,
        currencyCode: 'INR',
        transactionDate: indiaTodayIso(),
        categoryId: 'other',
        attachmentIds: [],
        createdAt: '2026-10-01T12:00:00Z',
        updatedAt: '2026-10-01T12:00:00Z',
      });
      await database.run(
        "INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES('keep-c2-sms','synthetic','2026-10-01','BANK_DEBIT','PENDING',NULL,'before')",
      );
      const tables = [
        'credit_cards',
        'card_transactions',
        'sms_candidates',
        'sms_reconciliation',
        'source_transfers',
        'source_balance_adjustments',
        'transaction_split_groups',
        'transaction_split_members',
        'loan_commitments',
        'emi_plans',
        'emi_installments',
        'recurring_rules',
        'bank_activity_profiles',
        'bank_activity_events',
        'mobile_recharges',
      ];
      const untouched = () => tables.map((table) => rows(`SELECT * FROM ${table} ORDER BY rowid`));
      const before = untouched();
      const sources = rows("SELECT * FROM app_preferences WHERE key='payment_sources'");
      await utilities.setLpgArchived(connection.id, true);
      await utilities.setLpgArchived(connection.id, false);
      if (archived) await utilities.setLpgArchived(connection.id, true);
      const profiles = utilities.lpgProfiles();
      const events = utilities.lpgEvents();
      sql.exec(
        "CREATE TRIGGER fail_lpg_delete BEFORE DELETE ON utility_profiles WHEN OLD.kind='LPG' BEGIN SELECT RAISE(ABORT,'connection delete rollback'); END",
      );
      await expect(utilities.deleteLpgProfile(connection.id)).rejects.toThrow(
        'connection delete rollback',
      );
      expect(utilities.lpgProfiles()).toBe(profiles);
      expect(utilities.lpgEvents()).toBe(events);
      expect(count('lpg_events')).toBe(4);
      sql.exec('DROP TRIGGER fail_lpg_delete');
      await expect(utilities.deleteLpgProfile(mobile.id)).rejects.toThrow(
        'LPG connection not found',
      );
      vi.stubGlobal('crypto', webcrypto);
      vi.stubGlobal('Blob', NodeBlob);
      try {
        const backups = TestBed.inject(BackupService);
        const prior = await backups.create('synthetic-lpg-deletion-passphrase');
        const atomic = database.atomic.bind(database);
        const published: boolean[] = [];
        const transaction = vi.spyOn(database, 'atomic').mockImplementation((work) =>
          atomic(async (tx) => {
            const result = await work(tx);
            published.push(utilities.lpgProfiles().some((row) => row.id === connection.id));
            return result;
          }),
        );
        await utilities.deleteLpgProfile(connection.id);
        transaction.mockRestore();
        expect(published).toEqual([true]);
        expect(utilities.lpgProfiles().map((row) => row.id)).toEqual([other.id]);
        expect(utilities.eventsFor(other.id)).toHaveLength(2);
        expect(untouched()).toEqual(before);
        expect(rows("SELECT * FROM app_preferences WHERE key='payment_sources'")).toEqual(sources);
        const after = await backups.create('synthetic-lpg-deletion-passphrase');
        const restarted = TestBed.runInInjectionContext(() => new UtilitiesService());
        await restarted.initialise();
        expect(restarted.eventsFor(connection.id)).toEqual([]);
        await backups.restore(prior.contents, 'synthetic-lpg-deletion-passphrase');
        await restarted.initialise();
        expect(restarted.eventsFor(connection.id)).toHaveLength(2);
        expect(restarted.lpgProfiles().find((row) => row.id === connection.id)?.archived).toBe(
          archived,
        );
        await backups.restore(after.contents, 'synthetic-lpg-deletion-passphrase');
        await restarted.initialise();
        expect(restarted.lpgProfiles().map((row) => row.id)).toEqual([other.id]);
        expect(restarted.eventsFor(other.id)).toHaveLength(2);
        expect(restarted.rechargesFor(mobile.id)).toHaveLength(1);
        expect(untouched()).toEqual(before);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('persists Utilities and Bank Activity through reload and encrypted backup while keeping finance isolated', async () => {
    const today = indiaTodayIso();
    await database.initialise();
    const store = TestBed.inject(CardNestStore);
    await store.initialisePreferences();
    const utilities = TestBed.inject(UtilitiesService);
    const bankActivity = TestBed.inject(BankActivityService);
    await Promise.all([utilities.initialise(), bankActivity.initialise()]);
    expect(utilities.settings()).toEqual({ showIndianUtilities: true, utilityReminders: false });
    expect(store.bankCashTracking().enabled).toBe(false);

    const mobile = await utilities.saveMobileProfile({
      personName: 'Fictional Sam',
      subscriptionType: 'PREPAID',
      operator: 'JIO',
      mobileNumber: '+91 98765 43210',
    });
    expect(mobile.mobileNumber).toBe('+91-9876543210');
    const queuedVoice = await utilities.saveRecharge({
      profileId: mobile.id,
      planType: 'VOICE_ONLY',
      amountMinor: 19900,
      startDate: today,
      validityDays: 3,
      comment: 'Synthetic queued voice plan',
    });
    const queuedData = await utilities.saveRecharge({
      profileId: mobile.id,
      planType: 'DATA_ONLY',
      startDate: today,
      validityDays: 2,
    });
    expect(queuedVoice.endDate).toBe(addCalendarDays(today, 2));
    expect(queuedData.planType).toBe('DATA_ONLY');

    const lpg = await utilities.saveLpgProfile({
      connectionName: 'Fictional kitchen',
      provider: 'INDANE',
      commercial: false,
      cylinderSize: 'NORMAL',
      estimatedUsageDays: 25,
    });
    await utilities.saveLpgEvent({
      profileId: lpg.id,
      eventType: 'STARTED',
      eventDate: '2026-08-01',
    });
    await utilities.saveLpgEvent({
      profileId: lpg.id,
      eventType: 'EMPTY',
      eventDate: '2026-08-25',
    });
    await utilities.saveLpgEvent({
      profileId: lpg.id,
      eventType: 'REFILL_RECEIVED',
      eventDate: '2026-08-27',
      amountMinor: 95000,
      cylinderSize: 'NORMAL',
    });
    const currentLpg = await utilities.saveLpgProfile({
      connectionName: 'Fictional active cylinder',
      provider: 'HPCL',
      commercial: false,
      cylinderSize: 'SMALL',
      estimatedUsageDays: 25,
    });
    await utilities.saveLpgEvent({
      profileId: currentLpg.id,
      eventType: 'STARTED',
      eventDate: addCalendarDays(today, -24),
    });

    const linkedBank = await store.addBankAccount({
      nickname: 'Fiction activity bank',
      institution: 'ICICI Bank',
      lastDigits: '417',
    });
    const bankProfile = await bankActivity.saveProfile({
      paymentSourceId: linkedBank.id,
      bankName: '',
      owner: 'OWN',
      nickname: 'Household account',
    });
    const manualEvent = await bankActivity.saveManualEvent({
      profileId: bankProfile.id,
      activityDate: '2026-04-24',
      direction: 'CREDIT',
      reference: 'SYNTHREF123',
    });
    expect(manualEvent.verification).toBe('USER_CONFIRMED');
    const temporaryEvent = await bankActivity.saveManualEvent({
      profileId: bankProfile.id,
      activityDate: '2026-04-20',
      direction: 'DEBIT',
    });
    const correctedEvent = await bankActivity.saveManualEvent({
      id: temporaryEvent.id,
      profileId: bankProfile.id,
      activityDate: '2026-04-21',
      direction: 'DEBIT',
    });
    expect(correctedEvent.origin).toBe('MANUAL');
    expect(correctedEvent.createdAt).toBe(temporaryEvent.createdAt);
    await bankActivity.deleteEvent(correctedEvent.id);
    const nativePlatform = vi.spyOn(Capacitor, 'isNativePlatform');
    nativePlatform.mockReturnValue(false);
    expect(
      await bankActivity.ingestAndroidSms({
        fingerprint: 'c'.repeat(64),
        activityDate: today,
        kind: 'BANK_DEBIT',
        direction: 'DEBIT',
        purposeHint: 'PURCHASE',
        accountDigits: '417',
        issuer: 'ICICI',
      }),
    ).toBe(false);
    nativePlatform.mockReturnValue(true);
    expect(store.bankCashTracking().enabled).toBe(false);
    expect(
      store.paymentSources().find((item) => item.id === linkedBank.id)?.balanceMinor,
    ).toBeUndefined();

    const smsEvidence = {
      fingerprint: 'a'.repeat(64),
      activityDate: today,
      kind: 'BANK_DEBIT',
      direction: 'DEBIT' as const,
      purposeHint: 'PURCHASE',
      accountDigits: '417',
      issuer: 'ICICI',
      reference: 'SYNTHRRN123',
      merchant: 'Fictional market',
    };
    expect(
      await bankActivity.ingestAndroidSms({
        ...smsEvidence,
        fingerprint: 'd'.repeat(64),
        purposeHint: 'INCOMING',
        direction: 'CREDIT',
        merchant: 'Monthly interest credit',
      }),
    ).toBe(false);
    expect(await bankActivity.ingestAndroidSms(smsEvidence)).toBe(false);
    expect(bankActivity.eventsFor(bankProfile.id)).toHaveLength(1);
    await bankActivity.approveCandidate(smsEvidence.fingerprint, bankProfile.id);
    expect(await bankActivity.ingestAndroidSms(smsEvidence)).toBe(false);
    expect(bankActivity.eventsFor(bankProfile.id)).toHaveLength(2);
    expect(count('card_transactions')).toBe(0);
    expect(count('source_transfers')).toBe(0);

    const ambiguousProfile = await bankActivity.saveProfile({
      bankName: 'ICICI Bank',
      accountSuffix: '417',
      owner: 'OTHERS',
      holderName: 'Fictional Alex',
      allowIdentityConflict: true,
    });
    expect(
      await bankActivity.ingestAndroidSms({ ...smsEvidence, fingerprint: 'b'.repeat(64) }),
    ).toBe(false);
    expect(bankActivity.candidates()).toMatchObject([
      {
        fingerprint: 'b'.repeat(64),
        activityDate: today,
        bankName: 'ICICI Bank',
        accountSuffix: '417',
      },
    ]);
    await bankActivity.approveCandidate('b'.repeat(64), ambiguousProfile.id);
    expect(bankActivity.eventsFor(ambiguousProfile.id)).toMatchObject([
      { origin: 'ANDROID_SMS', verification: 'USER_CONFIRMED', fingerprint: 'b'.repeat(64) },
    ]);
    expect(
      await bankActivity.ingestAndroidSms({
        ...smsEvidence,
        fingerprint: 'e'.repeat(64),
        issuer: undefined,
      }),
    ).toBe(false);
    expect(bankActivity.candidates()).toHaveLength(1);

    const dismissedFingerprint = 'f'.repeat(64);
    expect(
      await bankActivity.ingestAndroidSms({ ...smsEvidence, fingerprint: dismissedFingerprint }),
    ).toBe(false);
    await bankActivity.dismissCandidate(dismissedFingerprint);
    expect(
      bankActivity.candidates().some((item) => item.fingerprint === dismissedFingerprint),
    ).toBe(false);
    expect(
      await bankActivity.ingestAndroidSms({ ...smsEvidence, fingerprint: dismissedFingerprint }),
    ).toBe(false);

    await utilities.setUtilityReminders(true);
    expect(
      utilities
        .reminderTargets(today)
        .map((target) => target.kind)
        .sort(),
    ).toEqual(['LPG_ESTIMATE', 'MOBILE_PLAN', 'MOBILE_PLAN', 'MOBILE_VOICE', 'MOBILE_VOICE']);
    await utilities.setShowIndianUtilities(false);
    expect(utilities.reminderTargets(today)).toEqual([]);
    expect(utilities.mobileProfiles()).toHaveLength(1);
    await utilities.setShowIndianUtilities(true);
    expect(utilities.utilityReminders()).toBe(true);
    await database.run(
      'INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES(?,?,?,?,?,?,?)',
      [
        'synthetic-raw-exclusion',
        'synthetic-provider',
        today,
        'BANK_DEBIT',
        'PENDING',
        JSON.stringify({ body: 'SYNTHETIC_RAW_SMS_MUST_NOT_BE_BACKED_UP' }),
        new Date().toISOString(),
      ],
    );

    await database.run(
      'INSERT INTO app_preferences(key,encrypted_value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value',
      [
        SMS_REVIEW_FILTERS_KEY,
        JSON.stringify({ ...defaultReviewFilters(), sortOrder: 'TRANSACTION_DESC' }),
      ],
    );
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const fullBackup = await backups.create('synthetic-utilities-passphrase');
      const plaintext = await database.exportBackupJson();
      expect(plaintext).not.toContain('SYNTHETIC_RAW_SMS_MUST_NOT_BE_BACKED_UP');
      await database.run('DELETE FROM bank_activity_events');
      await database.run('DELETE FROM bank_activity_profiles');
      await database.run('DELETE FROM lpg_events');
      await database.run('DELETE FROM mobile_recharges');
      await database.run('DELETE FROM utility_profiles');
      await database.run('DELETE FROM app_preferences WHERE key IN (?,?)', [
        SHOW_INDIAN_UTILITIES_KEY,
        UTILITY_REMINDERS_KEY,
      ]);
      await backups.restore(fullBackup.contents, 'synthetic-utilities-passphrase');
      const restoredUtilities = TestBed.runInInjectionContext(() => new UtilitiesService());
      const restoredBankActivity = TestBed.runInInjectionContext(() => new BankActivityService());
      const restoredStore = TestBed.runInInjectionContext(() => new CardNestStore());
      await Promise.all([
        restoredStore.initialisePreferences(),
        restoredUtilities.initialise(),
        restoredBankActivity.initialise(),
      ]);
      const [restoredReviewPreference] = await database.query<{ encrypted_value: string }>(
        'SELECT encrypted_value FROM app_preferences WHERE key=?',
        [SMS_REVIEW_FILTERS_KEY],
      );
      expect(reviewFilters(JSON.parse(restoredReviewPreference.encrypted_value)).sortOrder).toBe(
        'TRANSACTION_DESC',
      );
      expect(restoredUtilities.settings()).toEqual({
        showIndianUtilities: true,
        utilityReminders: true,
      });
      expect(restoredUtilities.mobileProfiles()).toEqual([mobile]);
      expect(
        restoredUtilities
          .mobileRecharges()
          .map((item) => item.id)
          .sort(),
      ).toEqual([queuedVoice.id, queuedData.id].sort());
      expect(
        restoredUtilities
          .lpgProfiles()
          .map((item) => item.id)
          .sort(),
      ).toEqual([lpg.id, currentLpg.id].sort());
      expect(restoredUtilities.lpgEvents()).toHaveLength(4);
      expect(
        restoredBankActivity
          .profiles()
          .map((item) => item.id)
          .sort(),
      ).toEqual([bankProfile.id, ambiguousProfile.id].sort());
      expect(restoredBankActivity.eventsFor(bankProfile.id)).toHaveLength(2);
      expect(
        restoredBankActivity.eventsFor(bankProfile.id).some((item) => item.origin === 'MANUAL'),
      ).toBe(true);
      expect(
        restoredBankActivity
          .eventsFor(bankProfile.id)
          .some((item) => item.origin === 'ANDROID_SMS'),
      ).toBe(true);
      expect(restoredBankActivity.eventsFor(ambiguousProfile.id)).toMatchObject([
        { origin: 'ANDROID_SMS', verification: 'USER_CONFIRMED', fingerprint: 'b'.repeat(64) },
      ]);
      expect(restoredBankActivity.candidates()).toMatchObject([
        { fingerprint: 'e'.repeat(64), activityDate: today, accountSuffix: '417' },
      ]);
      const [dismissedCandidate] = await database.query<{ payload: string }>(
        'SELECT payload FROM bank_activity_candidates WHERE fingerprint=?',
        [dismissedFingerprint],
      );
      expect(JSON.parse(dismissedCandidate.payload)).toMatchObject({ dismissed: true });
      expect(restoredStore.bankCashTracking().enabled).toBe(false);
      expect(count('card_transactions')).toBe(0);
      expect(count('source_transfers')).toBe(0);

      const oldPortable = JSON.parse(await database.exportBackupJson()) as {
        databaseVersion: number;
        tables: { name: string; rows: Record<string, unknown>[] }[];
      };
      oldPortable.databaseVersion = 9;
      oldPortable.tables = oldPortable.tables
        .filter(
          (table) =>
            ![
              'utility_profiles',
              'mobile_recharges',
              'lpg_events',
              'bank_activity_profiles',
              'bank_activity_events',
              'bank_activity_candidates',
            ].includes(table.name),
        )
        .map((table) =>
          table.name === 'app_preferences'
            ? {
                ...table,
                rows: table.rows.filter(
                  (row) =>
                    ![SHOW_INDIAN_UTILITIES_KEY, UTILITY_REMINDERS_KEY].includes(
                      String(row['key']),
                    ) && String(row['key']) !== SMS_REVIEW_FILTERS_KEY,
                ),
              }
            : table,
        );
      const exportSpy = vi
        .spyOn(database, 'exportBackupJson')
        .mockResolvedValue(JSON.stringify(oldPortable));
      const oldBackup = await backups.create('synthetic-old-utilities-passphrase');
      exportSpy.mockRestore();
      await backups.restore(oldBackup.contents, 'synthetic-old-utilities-passphrase');
      const [oldReviewPreference] = await database.query<{ encrypted_value: string }>(
        'SELECT encrypted_value FROM app_preferences WHERE key=?',
        [SMS_REVIEW_FILTERS_KEY],
      );
      expect(oldReviewPreference).toBeUndefined();
      expect(reviewFilters(undefined).sortOrder).toBe('RECEIVED_DESC');
      const oldUtilities = TestBed.runInInjectionContext(() => new UtilitiesService());
      await oldUtilities.initialise();
      expect(oldUtilities.settings()).toEqual({
        showIndianUtilities: true,
        utilityReminders: false,
      });
      expect(oldUtilities.mobileProfiles()).toEqual([]);
      expect(oldUtilities.lpgProfiles()).toEqual([]);
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
    await review.approve(
      purchase,
      wallet.id,
      50000,
      'Fictional breakfast',
      '',
      'PENDING',
      false,
      '',
      0,
      { categoryId: 'dining' },
    );
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
    expect(sql.prepare('PRAGMA user_version').get()?.['user_version']).toBe(14);
  });
});
