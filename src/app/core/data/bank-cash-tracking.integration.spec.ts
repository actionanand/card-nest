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
import {
  CardTransaction,
  CreditCard,
  EmiPlan,
  LoanCommitment,
  PaymentSource,
  RecurringRule,
} from '../models/domain';
import { createEmiSchedule } from '../services/emi';
import { SmsReviewService } from '../../features/sms-sync/sms-review.service';
import { SmsCandidate, SmsEvidence } from '../../features/sms-sync/sms-model';
import {
  defaultReviewFilters,
  SMS_REVIEW_FILTERS_KEY,
} from '../../features/sms-sync/sms-review-filters';
import { BackupService } from '../services/backup.service';
import { webcrypto } from 'node:crypto';
import { provideRouter } from '@angular/router';
import { TransactionsPage } from '../../features/transactions/transactions';
import { By } from '@angular/platform-browser';
import { AppSelectPicker } from '../../shared/app-select-picker';
import { Blob as NodeBlob } from 'node:buffer';
import { BankActivityService } from '../../features/bank-activity/bank-activity.service';
import { BankAccountSyncService } from '../../features/bank-activity/bank-account-sync.service';
import { CardsPage } from '../../features/cards/cards';
import { RemindersPage } from '../../features/reminders/reminders';
import { SnackbarService } from '../services/snackbar.service';

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
  const financialState = () => [
    ...[
      'card_transactions',
      'credit_cards',
      'source_transfers',
      'source_balance_adjustments',
      'transaction_split_groups',
      'transaction_split_members',
      'sms_candidates',
      'sms_reconciliation',
      'statements',
      'categories',
    ].map((table) => rows('SELECT * FROM ' + table + ' ORDER BY rowid')),
    (
      JSON.parse(
        String(
          rows("SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'")[0]?.[
            'encrypted_value'
          ] ?? '[]',
        ),
      ) as PaymentSource[]
    )
      .filter((source) => source.balanceMinor !== undefined)
      .map((source) => ({
        id: source.id,
        balanceMinor: source.balanceMinor,
        balanceCutoverAt: source.balanceCutoverAt,
        balanceSnapshotMinor: source.balanceSnapshotMinor,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  ];
  it('merges concurrent committed source edits, preserves later changes and refreshes the linked identity after navigation', async () => {
    const { store, stored } = await boot();
    const source = await store.addBankAccount({
      nickname: 'Original',
      institution: 'ICICI',
      lastDigits: '00123',
    });
    await store.enableBankCashTracking({ [source.id]: 12000 });
    const activity = TestBed.inject(BankActivityService);
    await activity.reload();
    const profile = activity.profiles().find((row) => row.paymentSourceId === source.id)!;
    await activity.saveProfile({ ...profile, nickname: 'Independent monitor nickname' });
    const before = financialState();
    const otherSources = store.paymentSources().filter((row) => row.id !== source.id);
    const current = store.paymentSources().find((row) => row.id === source.id)!;
    const bankEdit = store.updatePaymentSource({ ...current, institution: 'HDFC Bank' });
    const suffixEdit = store.updatePaymentSource({
      ...current,
      nickname: 'Later nickname',
      lastDigits: '00007',
    });
    await Promise.all([bankEdit, suffixEdit, activity.reload(), activity.reload()]);
    await activity.reload();
    expect(store.paymentSources().find((row) => row.id === source.id)).toMatchObject({
      institution: 'HDFC Bank',
      nickname: 'Later nickname',
      lastDigits: '00007',
      balanceMinor: 12000,
      balanceCutoverAt: current.balanceCutoverAt,
    });
    expect(activity.profiles().find((row) => row.id === profile.id)).toMatchObject({
      paymentSourceId: source.id,
      bankName: 'ICICI',
      accountSuffix: '123',
      nickname: 'Independent monitor nickname',
    });
    expect(activity.profiles()).toHaveLength(1);
    expect(activity.accountSync.conflicts().join(' ')).toContain('linked identity changed');
    expect(stored(source.id)).toBe(12000);
    expect(financialState()).toEqual(before);
    expect(store.paymentSources().filter((row) => row.id !== source.id)).toEqual(otherSources);
  });
  it.each(['source', 'profile'] as const)(
    'preserves linked IDs and financial records when archiving/restoring the %s',
    async (side) => {
      const { store } = await boot();
      const source = await store.addBankAccount({
        nickname: 'Archive case',
        institution: 'ICICI',
        lastDigits: '00007',
      });
      await store.enableBankCashTracking({ [source.id]: 12000 });
      const activity = TestBed.inject(BankActivityService);
      await activity.reload();
      const profile = activity.profiles().find((row) => row.paymentSourceId === source.id)!;
      const before = financialState();
      if (side === 'source') await store.updatePaymentSource({ ...source, archived: true });
      else await activity.setArchived(profile.id, true);
      await Promise.all([activity.reload(), activity.reload()]);
      expect(activity.profiles()).toHaveLength(1);
      expect(activity.profiles()[0]).toMatchObject({
        id: profile.id,
        paymentSourceId: source.id,
        archived: side === 'profile',
        accountSuffix: '007',
      });
      if (side === 'source')
        expect(activity.accountSync.conflicts().join(' ')).toContain('archived');
      if (side === 'source')
        await store.updatePaymentSource({
          ...store.paymentSources().find((row) => row.id === source.id)!,
          archived: false,
        });
      else await activity.setArchived(profile.id, false);
      await activity.reload();
      expect(activity.profiles()[0].id).toBe(profile.id);
      expect(financialState()).toEqual(before);
    },
  );
  it('requires ownership confirmation, safely unlinks OWN to OTHERS, and does not re-enroll the family profile', async () => {
    const { store } = await boot();
    const activity = TestBed.inject(BankActivityService);
    const family = await activity.saveProfile({
      bankName: 'ICICI',
      accountSuffix: '007',
      owner: 'OTHERS',
      holderName: 'Family',
    });
    await store.enableBankCashTracking({});
    const before = financialState();
    await expect(activity.saveProfile({ ...family, owner: 'OWN' })).rejects.toThrow('Confirm');
    const own = await activity.saveProfile({ ...family, owner: 'OWN', confirmOwnershipSync: true });
    const source = store.paymentSources().find((row) => row.id === own.paymentSourceId)!;
    expect(source.lastDigits).toBe('007');
    expect(source.balanceMinor).toBeUndefined();
    await expect(
      activity.saveProfile({ ...own, owner: 'OTHERS', holderName: 'Family' }),
    ).rejects.toThrow('Only an account');
    await activity.saveProfile({
      ...own,
      paymentSourceId: undefined,
      owner: 'OTHERS',
      holderName: 'Family',
    });
    await Promise.all([activity.accountSync.reconcile(), activity.accountSync.reconcile()]);
    await activity.reload();
    expect(activity.profiles()).toHaveLength(1);
    expect(activity.profiles()[0].owner).toBe('OTHERS');
    expect(activity.profiles()[0].paymentSourceId).toBeUndefined();
    expect(store.paymentSources().find((row) => row.id === source.id)).toEqual(source);
    expect(financialState()).toEqual(before);
  });
  it('rolls back failed reconciliation, retries concurrent calls once per identity and preserves links through encrypted restore', async () => {
    const { store } = await boot();
    const source = await store.addBankAccount({
      nickname: 'Source nickname',
      institution: 'ICICI',
      lastDigits: '00123',
    });
    await store.enableBankCashTracking({ [source.id]: 12345 });
    const before = financialState();
    const sync = TestBed.inject(BankAccountSyncService);
    sql.exec(
      "CREATE TRIGGER fail_new_profile BEFORE INSERT ON bank_activity_profiles BEGIN SELECT RAISE(ABORT,'reconcile failure'); END",
    );
    await expect(sync.reconcile()).rejects.toThrow('reconcile failure');
    expect(count('bank_activity_profiles')).toBe(0);
    sql.exec('DROP TRIGGER fail_new_profile');
    await Promise.all([sync.reconcile(), sync.reconcile(), sync.reconcile()]);
    const activity = TestBed.inject(BankActivityService);
    await activity.reload();
    const profile = activity.profiles()[0];
    await activity.saveProfile({ ...profile, nickname: 'Monitor nickname' });
    expect(activity.profiles()).toHaveLength(1);
    expect(activity.events()).toHaveLength(0);
    await activity.saveManualEvent({
      profileId: profile.id,
      direction: 'DEBIT',
      activityDate: '2026-10-25',
    });
    await activity.saveManualEvent({
      profileId: profile.id,
      direction: 'CREDIT',
      activityDate: '2026-10-22',
    });
    const legacy = {
      id: 'legacy-history',
      profileId: profile.id,
      direction: 'DEBIT',
      activityDate: '2026-10-20',
      origin: 'ANDROID_SMS',
      verification: 'USER_CONFIRMED',
      fingerprint: 'legacy-processed',
      createdAt: '2026-10-20',
      updatedAt: '2026-10-20',
    };
    sql
      .prepare('INSERT INTO bank_activity_events VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        legacy.id,
        profile.id,
        legacy.activityDate,
        legacy.direction,
        legacy.origin,
        legacy.verification,
        legacy.fingerprint,
        JSON.stringify(legacy),
        legacy.createdAt,
        legacy.updatedAt,
      );
    sql.exec('PRAGMA user_version=13');
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backup = await TestBed.inject(BackupService).create('synthetic-hardening-passphrase');
      await store.disableBankCashTracking();
      await activity.reload();
      expect(count('bank_activity_profiles')).toBe(1);
      const beforeFailure = rows('SELECT * FROM bank_activity_events ORDER BY id');
      sql.exec(
        "CREATE TRIGGER fail_monitor_restore BEFORE INSERT ON bank_activity_events BEGIN SELECT RAISE(ABORT,'monitor restore failure'); END",
      );
      await expect(
        TestBed.inject(BackupService).restore(backup.contents, 'synthetic-hardening-passphrase'),
      ).rejects.toThrow('monitor restore failure');
      expect(rows('SELECT * FROM bank_activity_events ORDER BY id')).toEqual(beforeFailure);
      expect(financialState()).toEqual(before);
      sql.exec('DROP TRIGGER fail_monitor_restore');
      await TestBed.inject(BackupService).restore(
        backup.contents,
        'synthetic-hardening-passphrase',
      );
      await activity.reload();
      expect(
        activity
          .events()
          .map((event) => event.activityDate)
          .sort(),
      ).toEqual(['2026-10-22', '2026-10-25']);
      expect(
        rows(
          "SELECT payload FROM bank_activity_candidates WHERE fingerprint='legacy-processed'",
        )[0]['payload'],
      ).toContain('resolvedAt');
      expect(activity.profiles()[0]).toMatchObject({
        id: profile.id,
        paymentSourceId: source.id,
        nickname: 'Monitor nickname',
      });
      expect(store.paymentSources().find((row) => row.id === source.id)).toMatchObject({
        nickname: 'Source nickname',
        lastDigits: '00123',
        balanceMinor: 12345,
      });
      expect(financialState()).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('stages bank discoveries, rolls back failed confirmation and records once with no financial side effects', async () => {
    const { store } = await boot();
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const activity = TestBed.inject(BankActivityService);
    await activity.initialise();
    const source = await store.addBankAccount({
      nickname: 'Fiction account',
      institution: 'ICICI Bank',
      lastDigits: '45123',
    });
    const profile = await activity.saveProfile({
      paymentSourceId: source.id,
      bankName: 'ICICI',
      owner: 'OWN',
    });
    expect(profile.accountSuffix).toBe('123');
    expect(store.paymentSources().find((row) => row.id === source.id)?.lastDigits).toBe('45123');
    const payment = purchase({
      id: 'financial-preserved',
      merchant: 'Fiction meal',
      amountMinor: 20000,
    });
    const additional = purchase({ id: 'financial-member', cardId: source.id, amountMinor: 2000 });
    await store.saveManualTransaction(payment);
    await store.saveManualTransaction(additional);
    await store.combinePayments([payment.id, additional.id], payment.id);
    const financialTables = [
      'card_transactions',
      'transaction_split_groups',
      'transaction_split_members',
      'credit_cards',
      'source_transfers',
      'source_balance_adjustments',
      'app_preferences',
      'sms_candidates',
    ];
    const financial = () =>
      financialTables.map((table) => rows('SELECT * FROM ' + table + ' ORDER BY rowid'));
    const snapshot = financial();
    const sourceSnapshot = store.paymentSources();
    const spending = calculateNetSpending(store.transactions());
    const item = {
      fingerprint: 'bank-confirmation-a',
      activityDate: today,
      kind: 'BANK_DEBIT',
      direction: 'DEBIT' as const,
      purposeHint: 'PURCHASE',
      accountDigits: '45123',
      issuer: 'ICICI',
      merchant: 'Fiction store',
      reference: 'SAFE-REF',
      parserVersion: 3,
      dateFallback: false,
    };
    await activity.ingestAndroidSms(item);
    await activity.ingestAndroidSms(item);
    expect(activity.events()).toHaveLength(0);
    expect(activity.candidates()).toHaveLength(1);
    expect(activity.match(activity.candidates()[0])).toMatchObject({
      state: 'UNIQUE',
      suggestedId: profile.id,
    });
    expect(financial()).toEqual(snapshot);
    sql.exec(
      "CREATE TRIGGER fail_activity_resolve BEFORE UPDATE ON bank_activity_candidates BEGIN SELECT RAISE(ABORT,'synthetic activity rollback'); END",
    );
    await expect(activity.approveCandidate(item.fingerprint, profile.id)).rejects.toThrow(
      'synthetic activity rollback',
    );
    expect(count('bank_activity_events')).toBe(0);
    expect(activity.events()).toHaveLength(0);
    expect(activity.candidates()).toHaveLength(1);
    expect(financial()).toEqual(snapshot);
    sql.exec('DROP TRIGGER fail_activity_resolve');
    const results = await Promise.all([
      activity.approveCandidate(item.fingerprint, profile.id),
      activity.approveCandidate(item.fingerprint, profile.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(activity.events()).toHaveLength(1);
    expect(activity.events()[0]).toMatchObject({
      verification: 'USER_CONFIRMED',
      origin: 'ANDROID_SMS',
    });
    expect(activity.candidates()).toHaveLength(0);
    expect(financial()).toEqual(snapshot);
    expect(store.paymentSources()).toEqual(sourceSnapshot);
    expect(calculateNetSpending(store.transactions())).toBe(spending);
    await activity.ingestAndroidSms(item);
    expect(count('bank_activity_events')).toBe(1);
    expect(activity.candidates()).toHaveLength(0);
    await activity.ingestAndroidSms({
      ...item,
      fingerprint: 'new-bank-evidence',
      issuer: 'HDFC',
      accountDigits: '12007',
    });
    await activity.ingestAndroidSms({
      ...item,
      fingerprint: 'new-bank-evidence-two',
      issuer: 'HDFC Bank',
      accountDigits: '007',
    });
    expect(activity.candidates()).toHaveLength(2);
    expect(count('bank_activity_profiles')).toBe(1);
    await activity.saveProfile({
      bankName: 'HDFC Bank',
      accountSuffix: '007',
      owner: 'OTHERS',
      holderName: 'Fiction Jamie',
    });
    expect(activity.events()).toHaveLength(1);
    expect(activity.candidates()).toHaveLength(1);
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      await database.run(
        "INSERT INTO app_preferences(key,encrypted_value) VALUES('bank_activity_discovery_cursor','9999') ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value",
      );
      const backup = await TestBed.inject(BackupService).create(
        'synthetic-bank-discovery-passphrase',
      );
      await activity.dismissCandidates(activity.candidates().map((row) => row.fingerprint));
      await TestBed.inject(BackupService).restore(
        backup.contents,
        'synthetic-bank-discovery-passphrase',
      );
      await activity.reload();
      expect(
        rows("SELECT * FROM app_preferences WHERE key='bank_activity_discovery_cursor'"),
      ).toEqual([]);
      expect(activity.candidates()).toHaveLength(1);
      expect(activity.events()).toHaveLength(1);
      expect(activity.profiles()).toHaveLength(2);
      expect(JSON.stringify(rows('SELECT payload FROM bank_activity_candidates'))).not.toContain(
        '45123',
      );
    } finally {
      vi.unstubAllGlobals();
    }
    await activity.setArchived(profile.id, true);
    await activity.ingestAndroidSms({ ...item, fingerprint: 'archived-account-evidence' });
    expect(
      activity.match(
        activity.candidates().find((row) => row.fingerprint === 'archived-account-evidence')!,
      ).state,
    ).toBe('ARCHIVED');
    await expect(
      activity.approveCandidate('archived-account-evidence', profile.id),
    ).rejects.toThrow('active monitored');
    await expect(
      activity.saveProfile({ paymentSourceId: source.id, bankName: 'ICICI', owner: 'OWN' }),
    ).rejects.toThrow('already monitored');
    expect(activity.events()).toHaveLength(1);
  });
  it('persists unknown-bank identity separately from activity approval through concurrency and encrypted restore', async () => {
    const { store } = await boot();
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const activity = TestBed.inject(BankActivityService);
    await activity.initialise();
    const source = await store.addBankAccount({
      nickname: 'Identity check account',
      institution: 'ICICI Bank',
      lastDigits: '45123',
    });
    const profile = await activity.saveProfile({
      paymentSourceId: source.id,
      bankName: 'ICICI Bank',
      owner: 'OWN',
    });
    const evidence = {
      fingerprint: 'unknown-bank-identity',
      activityDate: today,
      kind: 'BANK_DEBIT',
      direction: 'DEBIT' as const,
      purposeHint: 'PURCHASE',
      accountDigits: '45123',
      merchant: 'Synthetic merchant',
      reference: 'IDENTITY-REF',
      parserVersion: 3,
      dateFallback: false,
    };
    await activity.ingestAndroidSms(evidence);
    const before = financialState();
    const fingerprint = evidence.fingerprint;
    sql.exec(
      "CREATE TRIGGER fail_identity_confirmation BEFORE UPDATE ON bank_activity_candidates BEGIN SELECT RAISE(ABORT,'synthetic identity rollback'); END",
    );
    await expect(activity.confirmCandidateIdentity(fingerprint, profile.id)).rejects.toThrow(
      'synthetic identity rollback',
    );
    expect(count('bank_activity_events')).toBe(0);
    expect(
      JSON.parse(String(rows('SELECT payload FROM bank_activity_candidates')[0]['payload'])),
    ).not.toHaveProperty('resolvedAt');
    expect(financialState()).toEqual(before);
    sql.exec('DROP TRIGGER fail_identity_confirmation');
    const confirmations = await Promise.all([
      activity.confirmCandidateIdentity(fingerprint, profile.id),
      activity.confirmCandidateIdentity(fingerprint, profile.id),
    ]);
    expect(confirmations.every((item) => item.resolvedProfileId === profile.id)).toBe(true);
    expect(count('bank_activity_events')).toBe(0);
    expect(activity.events()).toHaveLength(0);
    expect(activity.candidates()).toMatchObject([
      {
        fingerprint,
        accountSuffix: '123',
        resolvedProfileId: profile.id,
      },
    ]);
    expect(activity.candidates()[0].dismissed).toBeUndefined();
    expect(
      JSON.parse(String(rows('SELECT payload FROM bank_activity_candidates')[0]['payload'])),
    ).toMatchObject({
      fingerprint,
      reference: 'IDENTITY-REF',
      resolvedProfileId: profile.id,
    });
    expect(financialState()).toEqual(before);

    await activity.reload();
    expect(activity.candidates()).toMatchObject([{ fingerprint, resolvedProfileId: profile.id }]);

    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backup = await TestBed.inject(BackupService).create('synthetic-identity-passphrase');
      await database.run('DELETE FROM bank_activity_candidates');
      await activity.reload();
      expect(activity.candidates()).toHaveLength(0);
      await TestBed.inject(BackupService).restore(backup.contents, 'synthetic-identity-passphrase');
      await activity.reload();
      expect(activity.candidates()).toMatchObject([
        { fingerprint, resolvedProfileId: profile.id, reference: 'IDENTITY-REF' },
      ]);
      expect(activity.events()).toHaveLength(0);
      expect(financialState()).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
    }

    await activity.approveCandidate(fingerprint, profile.id);
    expect(count('bank_activity_events')).toBe(1);
    expect(activity.events()).toMatchObject([
      { profileId: profile.id, fingerprint, verification: 'USER_CONFIRMED' },
    ]);
    expect(activity.candidates()).toHaveLength(0);
    expect(financialState()).toEqual(before);
  });
  it('updates OWN Money Source and monitoring identity atomically without changing balances or IDs', async () => {
    const { store, stored } = await boot();
    const source = await store.addBankAccount({
      nickname: 'Original account',
      institution: 'ICICI Bank',
      lastDigits: '00123',
    });
    await store.enableBankCashTracking({ [source.id]: 765400 });
    const activity = TestBed.inject(BankActivityService);
    await activity.reload();
    const profile = activity.profiles().find((row) => row.paymentSourceId === source.id)!;
    const balance = store.paymentSources().find((row) => row.id === source.id)!;
    const adjustments = count('source_balance_adjustments');

    await activity.updateOwnMoneySourceIdentity({
      sourceId: source.id,
      nickname: 'Updated account',
      institution: 'HDFC Bank',
      lastDigits: '00007',
    });
    expect(store.paymentSources().find((row) => row.id === source.id)).toMatchObject({
      id: source.id,
      nickname: 'Updated account',
      institution: 'HDFC Bank',
      lastDigits: '00007',
      balanceMinor: balance.balanceMinor,
      balanceCutoverAt: balance.balanceCutoverAt,
      balanceSnapshotMinor: balance.balanceSnapshotMinor,
    });
    expect(activity.profiles().find((row) => row.id === profile.id)).toMatchObject({
      id: profile.id,
      paymentSourceId: source.id,
      bankName: 'HDFC Bank',
      accountSuffix: '007',
    });
    expect(stored(source.id)).toBe(765400);
    expect(count('source_balance_adjustments')).toBe(adjustments);

    sql.exec(
      "CREATE TRIGGER fail_identity_edit BEFORE UPDATE ON bank_activity_profiles BEGIN SELECT RAISE(ABORT,'identity edit rollback'); END",
    );
    await expect(
      activity.updateOwnMoneySourceIdentity({
        sourceId: source.id,
        nickname: 'Should roll back',
        institution: 'Axis Bank',
        lastDigits: '00008',
      }),
    ).rejects.toThrow('identity edit rollback');
    sql.exec('DROP TRIGGER fail_identity_edit');
    expect(store.paymentSources().find((row) => row.id === source.id)).toMatchObject({
      nickname: 'Updated account',
      institution: 'HDFC Bank',
      lastDigits: '00007',
      balanceMinor: 765400,
    });
    expect(activity.profiles().find((row) => row.id === profile.id)?.bankName).toBe('HDFC Bank');
    expect(count('source_balance_adjustments')).toBe(adjustments);
  });
  it('replays only retained parsed bank evidence on explicit discovery, resumes safely and never resets review decisions', async () => {
    const { store } = await boot();
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const activity = TestBed.inject(BankActivityService);
    await activity.initialise();
    const item = evidence({
      id: '9'.repeat(64),
      accountDigits: '12007',
      issuer: 'HDFC',
      merchant: 'Fiction vendor',
    });
    await stage(item, 'REJECTED');
    const rejected = rows('SELECT * FROM sms_candidates');
    await activity.discoverSavedEvidence();
    expect(activity.candidates()).toHaveLength(1);
    expect(activity.events()).toHaveLength(0);
    expect(activity.profiles()).toHaveLength(0);
    expect(rows('SELECT * FROM sms_candidates')).toEqual(rejected);
    await activity.discoverSavedEvidence();
    expect(activity.candidates()).toHaveLength(1);
    await activity.dismissCandidate(item.id);
    await activity.discoverSavedEvidence();
    expect(activity.candidates()).toHaveLength(0);
    const manual = await activity.saveProfile({
      bankName: 'HDFC Bank',
      owner: 'OTHERS',
      holderName: 'Fiction Alex',
      manualOnly: true,
    });
    await activity.saveManualEvent({
      profileId: manual.id,
      activityDate: today,
      direction: 'DEBIT',
    });
    expect(activity.events()).toHaveLength(1);
    expect(count('card_transactions')).toBe(0);
    expect(count('source_transfers')).toBe(0);
    expect(store.transactions()).toHaveLength(0);
    const invalid = evidence({
      id: '8'.repeat(64),
      purposeHint: 'INCOMING',
      direction: 'CREDIT',
      merchant: 'NACH automatic interest credit',
    });
    await stage(invalid);
    await activity.discoverSavedEvidence();
    expect(activity.candidates()).toHaveLength(0);
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    await expect(activity.discoverSavedEvidence()).rejects.toThrow('Android');
    expect(activity.profiles()).toHaveLength(1);
  });
  it('reconciles old portable category backups on restore without changing history, deleted old defaults or custom IDs', async () => {
    const { store } = await boot();
    const item = purchase({
      id: 'old-category-payment',
      categoryId: 'groceries',
      reference: 'KEEP',
    });
    await store.saveManualTransaction(item);
    const backup = JSON.parse(await database.exportBackupJson()) as {
      databaseVersion: number;
      tables: { name: string; rows: Record<string, unknown>[] }[];
    };
    backup.databaseVersion = 12;
    backup.tables = backup.tables.filter(
      (table) => !['category_catalog_state', 'category_catalog_conflicts'].includes(table.name),
    );
    const prefs = backup.tables.find((table) => table.name === 'app_preferences')!;
    prefs.rows = prefs.rows.filter((row) => row['key'] !== 'category_catalog_version');
    const categories = backup.tables.find((table) => table.name === 'categories')!;
    categories.rows = categories.rows
      .filter(
        (row) =>
          ![
            'meat-dairy',
            'fresh-produce',
            'tech-gadgets',
            'household',
            'kids',
            'digital-goods',
            'snacks-pastry',
            'indulgences',
            'education',
            'dining',
          ].includes(String(row['id'])),
      )
      .map((row) =>
        row['id'] === 'groceries'
          ? { ...row, name: 'Groceries' }
          : row['id'] === 'travel'
            ? { ...row, name: 'Travel' }
            : row,
      );
    categories.rows.push({
      id: 'old-user-kids',
      name: '  KIDS  ',
      icon: 'custom',
      colour: '#123456',
      applies_to: 'BOTH',
      archived: 0,
    });
    await database.restoreBackupJson(JSON.stringify(backup));
    await store.initialisePreferences();
    expect(store.categories().find((row) => row.id === 'groceries')?.name).toBe('Pantry Staples');
    expect(store.categories().find((row) => row.id === 'travel')?.name).toBe('Travel & Lodging');
    expect(store.categories().find((row) => row.id === 'old-user-kids')).toMatchObject({
      name: 'Kids',
      colour: '#123456',
      icon: 'custom',
    });
    expect(store.categories().some((row) => row.id === 'kids' || row.id === 'dining')).toBe(false);
    expect(store.transactions().find((row) => row.id === item.id)?.reference).toBe('KEEP');
    expect(rows('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('serializes filter restoration after older saves, persists canonical defaults and rolls back failed preferences without financial changes', async () => {
    const { store, review } = await boot();
    const sources = store.paymentSources();
    const history = count('sms_candidates');
    const changed = {
      ...defaultReviewFilters(),
      search: 'earlier',
      state: 'ALL',
      kind: 'BANK_DEBIT',
      read: 'ALL',
      hideAlreadyAdded: false,
      sortOrder: 'TRANSACTION_DESC' as const,
    };
    await Promise.all([review.filterReview(changed), review.filterReview(defaultReviewFilters())]);
    expect(await review.loadReviewFilters()).toEqual(defaultReviewFilters());
    expect(review.reviewPage()).toBe(0);
    sql.exec(
      "CREATE TRIGGER fail_filters BEFORE UPDATE ON app_preferences WHEN NEW.key='sms_review_filters' BEGIN SELECT RAISE(ABORT,'synthetic filter failure'); END",
    );
    await expect(review.filterReview(changed)).rejects.toThrow('synthetic filter failure');
    expect(await review.loadReviewFilters()).toEqual(defaultReviewFilters());
    expect(store.paymentSources()).toEqual(sources);
    expect(count('sms_candidates')).toBe(history);
    expect(count('card_transactions')).toBe(0);
  });
  it('deletes a category with SQLite rollback safety and encrypted backup tombstones, preserving actual payment metadata', async () => {
    const { store } = await boot();
    const recorded = (id: string) =>
      JSON.parse(
        String(rows('SELECT payload FROM card_transactions WHERE id=?', [id])[0]['payload']),
      ) as CardTransaction;
    const original = purchase({
      id: 'category-payment',
      categoryId: 'kids',
      reference: 'UNCHANGED',
      origin: 'SMS',
      attachmentIds: ['receipt'],
      merchant: 'Recorded item',
    });
    await store.saveManualTransaction(original);
    await store.setCategoryLimit('kids', 500000, true);
    const sources = store.paymentSources();
    const originalStored = recorded(original.id);
    sql.exec(
      "CREATE TRIGGER fail_category_delete BEFORE DELETE ON categories BEGIN SELECT RAISE(ABORT,'synthetic category deletion failure'); END",
    );
    await expect(store.deleteCategory('kids')).rejects.toThrow(
      'synthetic category deletion failure',
    );
    expect(recorded(original.id)).toEqual(originalStored);
    expect(
      store.categories().some((row) => row.id === 'kids' && row.monthlyLimitMinor === 500000),
    ).toBe(true);
    expect(store.transactions().find((row) => row.id === original.id)).toEqual(originalStored);
    expect(store.paymentSources()).toEqual(sources);
    sql.exec('DROP TRIGGER fail_category_delete');
    await store.deleteCategory('kids');
    expect(recorded(original.id)).toEqual({ ...originalStored, categoryId: 'other' });
    expect(rows('SELECT category_id FROM card_transactions WHERE id=?', [original.id])).toEqual([
      { category_id: 'other' },
    ]);
    expect(count('category_limits')).toBe(0);
    expect(store.paymentSources()).toEqual(sources);
    await store.initialisePreferences();
    expect(store.categories().some((row) => row.id === 'kids')).toBe(false);
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-category-passphrase');
      await store.addCategory({
        id: 'recreated-kids',
        name: '  KIDS  ',
        icon: 'kids',
        colour: '#123456',
        appliesTo: 'BOTH',
        archived: false,
      });
      expect(store.categories().find((row) => row.id === 'recreated-kids')?.name).toBe('Kids');
      await backups.restore(backup.contents, 'synthetic-category-passphrase');
      await store.initialisePreferences();
      expect(store.categories().some((row) => row.name === 'Kids')).toBe(false);
      expect(store.categoryCatalog().find((row) => row.canonical_id === 'kids')?.deleted).toBe(1);
      expect(recorded(original.id)).toEqual({ ...originalStored, categoryId: 'other' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('suggests only for new manual entries, preserves explicit overrides and saved categories, and inherits new split categories', async () => {
    const { store } = await boot();
    const fixture = TestBed.createComponent(TransactionsPage);
    const page = fixture.componentInstance;
    page.openAdd();
    page.form.controls.merchant.setValue('Swiggy Instamart');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.form.controls.categoryId.value).toBe('groceries');
    page.setCategory('shopping');
    page.form.controls.merchant.setValue('Netflix');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.form.controls.categoryId.value).toBe('shopping');
    const existing = purchase({ id: 'saved-category', merchant: 'Netflix', categoryId: 'dining' });
    page.edit(existing);
    page.form.controls.merchant.setValue('Swiggy');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.form.controls.categoryId.value).toBe('dining');
    store.transactions.set([existing]);
    page.closeForm();
    page.openAdd();
    page.form.controls.type.setValue('ADJUSTMENT');
    page.setRelatedTransaction(existing.id);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.form.controls.categoryId.value).toBe('dining');
    expect(store.transactions()[0].categoryId).toBe('dining');
    page.setCategory('household');
    page.form.controls.merchant.setValue('Zomato');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.form.controls.categoryId.value).toBe('household');
    fixture.destroy();
  });
  it('adds canonical names without duplicate aliases and preserves custom names, IDs and settings on reload', async () => {
    const { store } = await boot();
    await store.deleteCategory('kids');
    await store.addCategory({
      id: 'user-kids',
      name: '  ＫＩＤＳ  ',
      icon: 'custom',
      colour: '#123456',
      appliesTo: 'BOTH',
      archived: false,
    });
    await store.setCategoryLimit('user-kids', 500000, false);
    await expect(
      store.addCategory({
        id: 'duplicate',
        name: 'Kids',
        icon: 'category',
        appliesTo: 'BOTH',
        archived: false,
      }),
    ).rejects.toThrow('already exists');
    await store.initialisePreferences();
    expect(store.categories().filter((row) => row.name === 'Kids')).toHaveLength(1);
    expect(store.categories().find((row) => row.id === 'user-kids')).toMatchObject({
      name: 'Kids',
      colour: '#123456',
      icon: 'custom',
      monthlyLimitMinor: 500000,
      showLimit: false,
    });
    expect(store.categoryCatalog().find((row) => row.canonical_id === 'kids')).toMatchObject({
      category_id: 'user-kids',
      deleted: 0,
    });
  });
  let sql: DatabaseSyncType;
  let database: SqliteDatabase;
  const lock = { locked: signal(false), foreground: signal(true) };
  const today = indiaTodayIso();
  const rows = (statement: string, values: readonly unknown[] = []) =>
    sql.prepare(statement).all(...(values as SQLInputValue[]));
  const count = (table: string) => Number(rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]['n']);
  const settle = () => database.atomic(async () => undefined);
  const deviceZone = (timeZone: string | undefined) => {
    const options = new Intl.DateTimeFormat().resolvedOptions();
    return vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ ...options, timeZone } as Intl.ResolvedDateTimeFormatOptions);
  };
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
      'INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at,received_at) VALUES(?,?,?,?,?,?,?,?)',
      [
        item.id,
        item.providerId,
        item.eventAt,
        item.kind,
        state,
        JSON.stringify(item),
        'now',
        item.receivedAt,
      ],
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

  async function recurringEditor(repeat: 'INFINITE' | `${number}` = 'INFINITE') {
    const result = await boot();
    result.store.addCard({ ...card, excludeStatementDayTransactions: true });
    await settle();
    deviceZone('Asia/Kolkata');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T06:30:00Z'));
    const fixture = TestBed.createComponent(TransactionsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    page.openAdd();
    page.form.patchValue({
      cardId: card.id,
      type: 'PURCHASE',
      amount: '1000',
      transactionDate: '2026-08-07',
      merchant: 'Synthetic monthly purchase',
      categoryId: 'other',
      repeat,
    });
    return { ...result, fixture, page };
  }

  const commitmentState = () => [
    financialState(),
    ...['emi_plans', 'emi_installments', 'loan_commitments', 'recurring_rules'].map((table) =>
      rows(`SELECT * FROM ${table} ORDER BY id`),
    ),
  ];

  async function startupHistory() {
    const { store } = await boot();
    store.addCard({ ...card, excludeStatementDayTransactions: true });
    await settle();
    for (let index = 0; index < 2; index++) {
      const original = purchase({
        id: `startup-purchase-${index}`,
        cardId: card.id,
        amountMinor: 120000,
        transactionDate: '2026-08-01',
      });
      await store.saveManualTransaction(original);
      const plan: EmiPlan = {
        id: `startup-plan-${index}`,
        transactionId: original.id,
        cardId: card.id,
        convertedAmountMinor: original.amountMinor,
        remainingPurchaseMinor: 0,
        tenureMonths: 3,
        annualRateBasisPoints: 0,
        interestType: 'NO_COST',
        processingFeeMinor: 0,
        taxMinor: 0,
        startDate: '2026-08-01',
        status: 'ACTIVE',
      };
      await store.saveEmiPlan(plan, createEmiSchedule(plan, card));
    }
    for (let index = 0; index < 3; index++) {
      const loan: LoanCommitment = {
        id: `startup-loan-${index}`,
        name: `Synthetic loan ${index}`,
        principalMinor: 100000,
        installmentMinor: 10000,
        debitDay: 5,
        startDate: '2026-01-05',
        endDate: '2027-01-05',
        status: 'ACTIVE',
      };
      await database.run(
        'INSERT INTO loan_commitments(id,status,payload,updated_at) VALUES(?,?,?,?)',
        [loan.id, loan.status, JSON.stringify(loan), '2026-01-01T00:00:00.000Z'],
      );
    }
    const rule: RecurringRule = {
      id: 'startup-due-rule',
      cardId: card.id,
      title: 'Startup due',
      amountMinor: 1000,
      categoryId: 'other',
      frequency: 'MONTHLY',
      startDate: '2026-10-07',
      nextOccurrenceDate: '2026-10-07',
      status: 'ACTIVE',
      occurrenceLimit: 1,
    };
    await database.run(
      'INSERT INTO recurring_rules(id,card_id,next_occurrence_date,status,payload) VALUES(?,?,?,?,?)',
      [rule.id, card.id, rule.nextOccurrenceDate, rule.status, JSON.stringify(rule)],
    );
    deviceZone('UTC');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T06:30:00Z'));
    return store;
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
        provideRouter([]),
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['INFINITE', '3', '1'] as const)(
    'catches up a newly saved card schedule through the real editor with limit %s only',
    async (repeat) => {
      const { store, fixture, page } = await recurringEditor(repeat);
      const unrelated: RecurringRule = {
        id: 'unrelated-due-rule',
        cardId: card.id,
        title: 'Unrelated',
        amountMinor: 2000,
        categoryId: 'other',
        frequency: 'MONTHLY',
        startDate: '2026-01-01',
        nextOccurrenceDate: '2026-01-01',
        status: 'ACTIVE',
      };
      await database.run(
        'INSERT INTO recurring_rules(id,card_id,next_occurrence_date,status,payload) VALUES(?,?,?,?,?)',
        [
          unrelated.id,
          card.id,
          unrelated.nextOccurrenceDate,
          unrelated.status,
          JSON.stringify(unrelated),
        ],
      );
      const oldMoney = financialState().slice(2);
      await Promise.all([page.save(), page.save(), page.save()]);
      expect(
        store
          .transactions()
          .map((item) => item.transactionDate)
          .sort(),
      ).toEqual(repeat === '1' ? ['2026-08-07'] : ['2026-08-07', '2026-09-07', '2026-10-07']);
      expect(
        store
          .transactions()
          .every(
            (item) =>
              item.amountMinor === 100000 &&
              item.currencyCode === 'INR' &&
              item.type === 'PURCHASE',
          ),
      ).toBe(true);
      expect(
        rows('SELECT next_occurrence_date FROM recurring_rules WHERE id=?', [unrelated.id])[0][
          'next_occurrence_date'
        ],
      ).toBe('2026-01-01');
      expect(financialState().slice(2)).toEqual(oldMoney);
      expect(store.cardOutstanding(card.id)).toBe(repeat === '1' ? 100000 : 300000);
      expect(page.showForm()).toBe(false);
      expect(page.saving()).toBe(false);
      fixture.destroy();
    },
  );

  it('keeps an initial recurring save retry on the same transaction and rule identity after commit failure', async () => {
    const { store, fixture, page } = await recurringEditor();
    const save = vi.spyOn(store, 'saveManualTransaction');
    vi.mocked(CapacitorSQLite.commitTransaction).mockRejectedValueOnce(
      new Error('initial recurring commit failure'),
    );
    const before = commitmentState();
    await page.save();
    expect(page.showForm()).toBe(true);
    expect(page.form.controls.amount.value).toBe('1000');
    expect(commitmentState()).toEqual(before);
    const firstId = save.mock.calls[0][0].id;
    const firstRuleId = save.mock.calls[0][3]!.id;
    await page.save();
    expect(save.mock.calls[1][0].id).toBe(firstId);
    expect(save.mock.calls[1][3]!.id).toBe(firstRuleId);
    expect(store.transactions().filter((item) => item.id === firstId)).toHaveLength(1);
    expect(count('card_transactions')).toBe(3);
    fixture.destroy();
  });

  it.each(['SQL', 'COMMIT', 'REFRESH'] as const)(
    'keeps the initial recurring entry committed when catch-up encounters %s failure',
    async (failure) => {
      const { store, fixture, page } = await recurringEditor();
      const save = vi.spyOn(store, 'saveManualTransaction');
      const snack = vi.spyOn(TestBed.inject(SnackbarService), 'show');
      if (failure === 'SQL')
        sql.exec(
          "CREATE TRIGGER fail_editor_catchup BEFORE INSERT ON card_transactions WHEN NEW.transaction_date='2026-10-07' BEGIN SELECT RAISE(ABORT,'editor catch-up SQL failure'); END",
        );
      const run = vi.mocked(CapacitorSQLite.run).getMockImplementation()!;
      let generated = false;
      vi.mocked(CapacitorSQLite.run).mockImplementation(async (options) => {
        const result = await run(options);
        if (
          options.statement?.includes('INSERT INTO card_transactions') &&
          options.values?.[6] === '2026-09-07'
        )
          generated = true;
        return result;
      });
      const commit = vi.mocked(CapacitorSQLite.commitTransaction).getMockImplementation()!;
      vi.mocked(CapacitorSQLite.commitTransaction).mockImplementation(async (options) => {
        if (generated && failure === 'COMMIT') {
          generated = false;
          throw new Error('catch-up commit failure');
        }
        const result = await commit(options);
        if (generated && failure === 'REFRESH') {
          generated = false;
          vi.mocked(CapacitorSQLite.query).mockRejectedValueOnce(
            new Error('catch-up refresh failure'),
          );
        }
        return result;
      });
      await page.save();
      expect(page.showForm()).toBe(false);
      expect(save).toHaveBeenCalledOnce();
      expect(count('card_transactions')).toBe(failure === 'REFRESH' ? 3 : 1);
      expect(count('recurring_rules')).toBe(1);
      expect(snack).toHaveBeenLastCalledWith(
        expect.stringMatching(failure === 'REFRESH' ? /saved.*refresh/i : /saved.*catch.up/i),
        'WARNING',
      );
      const initial = rows(
        "SELECT id FROM card_transactions WHERE transaction_date='2026-08-07'",
      )[0]['id'];
      expect(initial).toBe(save.mock.calls[0][0].id);
      if (failure === 'SQL') sql.exec('DROP TRIGGER fail_editor_catchup');
      vi.mocked(CapacitorSQLite.commitTransaction).mockImplementation(commit);
      const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
      await restarted.initialisePreferences();
      expect(count('card_transactions')).toBe(3);
      expect(
        rows("SELECT id FROM card_transactions WHERE transaction_date='2026-08-07'")[0]['id'],
      ).toBe(initial);
      fixture.destroy();
    },
  );

  it('holds the editor saving guard through catch-up and uses the timezone at its execution', async () => {
    const { store, fixture, page } = await recurringEditor();
    page.form.controls.transactionDate.setValue('2026-09-01');
    vi.setSystemTime(new Date('2026-09-30T19:00:00Z'));
    deviceZone('UTC');
    const materialize = store.materializeRecurringTransactions.bind(store);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(store, 'materializeRecurringTransactions').mockImplementation(async (...args) => {
      started();
      await gate;
      return materialize(...args);
    });
    const pending = page.save();
    // A missing editor invocation must fail the test rather than leave it waiting indefinitely.
    await Promise.race([entered, pending]);
    expect(page.saving()).toBe(true);
    await page.save();
    deviceZone('Asia/Kolkata');
    release();
    const ruleId = String(rows('SELECT id FROM recurring_rules')[0]['id']);
    await Promise.all([pending, materialize(undefined, ruleId)]);
    expect(
      store
        .transactions()
        .map((item) => item.transactionDate)
        .sort(),
    ).toEqual(['2026-09-01', '2026-10-01']);
    expect(count('recurring_rules')).toBe(1);
    fixture.destroy();
  });

  it.each(['SQL', 'COMMIT', 'REFRESH'] as const)(
    'loads existing EMI and loans despite startup recurring %s failure',
    async (failure) => {
      const previous = await startupHistory();
      const before = commitmentState();
      const outstanding = previous.cardOutstanding(card.id);
      const error = new Error(`startup recurring ${failure} failure`);
      if (failure === 'SQL')
        sql.exec(
          "CREATE TRIGGER fail_startup_recurrence BEFORE INSERT ON card_transactions WHEN json_extract(NEW.payload,'$.recurringRuleId')='startup-due-rule' BEGIN SELECT RAISE(ABORT,'startup recurring SQL failure'); END",
        );
      const run = vi.mocked(CapacitorSQLite.run).getMockImplementation()!;
      const commit = vi.mocked(CapacitorSQLite.commitTransaction).getMockImplementation()!;
      let generated = false;
      vi.mocked(CapacitorSQLite.run).mockImplementation(async (options) => {
        const result = await run(options);
        if (options.statement?.includes('INSERT INTO card_transactions')) generated = true;
        return result;
      });
      vi.mocked(CapacitorSQLite.commitTransaction).mockImplementation(async (options) => {
        if (generated && failure === 'COMMIT') {
          generated = false;
          throw error;
        }
        const result = await commit(options);
        if (generated && failure === 'REFRESH') {
          generated = false;
          vi.mocked(CapacitorSQLite.query).mockRejectedValueOnce(error);
        }
        return result;
      });
      const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
      let rejected: unknown;
      try {
        await restarted.initialisePreferences();
      } catch (cause: unknown) {
        rejected = cause;
      }
      expect(rejected).toBeDefined();
      if (failure === 'COMMIT') expect(rejected).toBe(error);
      if (failure === 'REFRESH')
        expect(rejected).toMatchObject({ name: 'CommittedSaveRefreshError', cause: error });
      expect(restarted.emiPlans()).toHaveLength(2);
      expect(restarted.emiInstallments()).toHaveLength(6);
      expect(restarted.loans()).toHaveLength(3);
      expect(
        (
          restarted as unknown as { initialisationWarning?: () => string }
        ).initialisationWarning?.(),
      ).toMatch(/recurring/i);
      const after = commitmentState();
      expect(after.slice(1, 4)).toEqual(before.slice(1, 4));
      if (failure !== 'REFRESH') {
        expect(after).toEqual(before);
        expect(restarted.cardOutstanding(card.id)).toBe(outstanding);
      } else {
        expect(count('card_transactions')).toBe(7);
        expect(restarted.cardOutstanding(card.id)).toBe(outstanding + 1000);
      }
      if (failure === 'SQL') sql.exec('DROP TRIGGER fail_startup_recurrence');
      vi.mocked(CapacitorSQLite.commitTransaction).mockImplementation(commit);
      const recovered = TestBed.runInInjectionContext(() => new CardNestStore());
      await recovered.initialisePreferences();
      expect(recovered.emiPlans()).toHaveLength(2);
      expect(recovered.loans()).toHaveLength(3);
      expect(count('card_transactions')).toBe(7);
      expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      if (failure === 'SQL') {
        const recoveredState = commitmentState();
        vi.stubGlobal('crypto', webcrypto);
        vi.stubGlobal('Blob', NodeBlob);
        const backups = TestBed.inject(BackupService);
        const backup = await backups.create('synthetic-startup-history-backup');
        await backups.restore(backup.contents, 'synthetic-startup-history-backup');
        const restored = TestBed.runInInjectionContext(() => new CardNestStore());
        await restored.initialisePreferences();
        expect(restored.emiPlans()).toHaveLength(2);
        expect(restored.loans()).toHaveLength(3);
        expect(commitmentState()).toEqual(recoveredState);
      }
    },
  );

  it('preserves the existing non-card editor path instead of extending its saving guard', async () => {
    const { store, fixture, page } = await recurringEditor();
    page.form.controls.cardId.setValue('source-cash');
    const add = store.addRecurringRule.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const legacy = vi.spyOn(store, 'addRecurringRule').mockImplementation(async (rule) => {
      entered();
      await gate;
      return add(rule);
    });
    const pending = page.save();
    await Promise.race([started, pending]);
    const savingDuringLegacyCall = page.saving();
    release();
    await pending;
    await settle();
    expect(legacy).toHaveBeenCalledOnce();
    expect(savingDuringLegacyCall).toBe(false);
    expect(page.showForm()).toBe(false);
    fixture.destroy();
  });

  it('finishes recurring catch-up after the initial save commits but its refresh fails', async () => {
    const { store, fixture, page } = await recurringEditor();
    const save = vi.spyOn(store, 'saveManualTransaction');
    const commit = vi.mocked(CapacitorSQLite.commitTransaction).getMockImplementation()!;
    vi.mocked(CapacitorSQLite.commitTransaction).mockImplementationOnce(async (options) => {
      const result = await commit(options);
      vi.mocked(CapacitorSQLite.query).mockRejectedValueOnce(
        new Error('initial committed refresh failure'),
      );
      return result;
    });
    const snack = vi.spyOn(TestBed.inject(SnackbarService), 'show');
    await page.save();
    expect(count('card_transactions')).toBe(3);
    expect(
      store.transactions().filter((item) => item.id === save.mock.calls[0][0].id),
    ).toHaveLength(1);
    expect(page.showForm()).toBe(false);
    expect(snack).toHaveBeenLastCalledWith(expect.stringContaining('Transaction saved'), 'WARNING');
    fixture.destroy();
  });

  it('round trips editor catch-up through encrypted backup and restore failure without replay', async () => {
    const { store, fixture, page } = await recurringEditor();
    await page.save();
    expect(count('card_transactions')).toBe(3);
    const before = commitmentState();
    const initialIds = store
      .transactions()
      .map((item) => item.id)
      .sort();
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    const backups = TestBed.inject(BackupService);
    const backup = await backups.create('synthetic-recurring-editor-backup');
    sql.exec(
      "CREATE TRIGGER fail_editor_restore BEFORE INSERT ON recurring_rules BEGIN SELECT RAISE(ABORT,'editor restore failure'); END",
    );
    await expect(
      backups.restore(backup.contents, 'synthetic-recurring-editor-backup'),
    ).rejects.toThrow('editor restore failure');
    expect(commitmentState()).toEqual(before);
    sql.exec('DROP TRIGGER fail_editor_restore');
    await backups.restore(backup.contents, 'synthetic-recurring-editor-backup');
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(commitmentState()).toEqual(before);
    expect(
      restarted
        .transactions()
        .map((item) => item.id)
        .sort(),
    ).toEqual(initialIds);
    vi.setSystemTime(new Date('2026-11-28T06:30:00Z'));
    await Promise.all([
      restarted.materializeRecurringTransactions(),
      restarted.materializeRecurringTransactions(),
    ]);
    expect(count('card_transactions')).toBe(4);
    expect(
      restarted.transactions().filter((item) => item.generatedOccurrenceDate === '2026-11-07'),
    ).toHaveLength(1);
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    fixture.destroy();
  });

  it('preserves all startup errors and prioritizes EMI/loan read failures over scheduling failure', async () => {
    await startupHistory();
    const before = commitmentState();
    const emiError = new Error('synthetic EMI read failure');
    const loanError = new Error('synthetic loan read failure');
    const query = vi.mocked(CapacitorSQLite.query).getMockImplementation()!;
    vi.mocked(CapacitorSQLite.query).mockImplementation(async (options) => {
      if (options.statement === 'SELECT payload FROM emi_plans ORDER BY rowid DESC') throw emiError;
      if (options.statement === 'SELECT payload FROM loan_commitments ORDER BY rowid DESC')
        throw loanError;
      return query(options);
    });
    sql.exec(
      "CREATE TRIGGER fail_combined_startup BEFORE INSERT ON card_transactions BEGIN SELECT RAISE(ABORT,'synthetic scheduling failure'); END",
    );
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    let rejected: unknown;
    try {
      await restarted.initialisePreferences();
    } catch (error: unknown) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(AggregateError);
    const errors = (rejected as AggregateError).errors as unknown[];
    expect(errors).toHaveLength(3);
    expect(errors[0]).toBe(emiError);
    expect(errors[1]).toBe(loanError);
    expect(errors[2]).toMatchObject({ message: 'synthetic scheduling failure' });
    expect(restarted.initialisationWarning()).toMatch(
      /^EMI history.*Loan history.*Recurring generation/,
    );
    expect(commitmentState()).toEqual(before);
  });

  it('loads loans after legacy EMI normalization failure and prioritizes a genuine history error', async () => {
    await startupHistory();
    sql.exec(
      "DELETE FROM recurring_rules; UPDATE card_transactions SET payload=json_remove(payload,'$.emiInstallmentNumber') WHERE id='startup-purchase-0'",
    );
    const before = commitmentState();
    sql.exec(
      "CREATE TRIGGER fail_legacy_normalization BEFORE UPDATE ON card_transactions BEGIN SELECT RAISE(ABORT,'legacy EMI normalization failure'); END",
    );
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await expect(restarted.initialisePreferences()).rejects.toThrow(
      'legacy EMI normalization failure',
    );
    expect(restarted.loans()).toHaveLength(3);
    expect(restarted.emiPlans()).toHaveLength(2);
    expect(commitmentState()).toEqual(before);
    expect(
      (restarted as unknown as { initialisationWarning?: () => string }).initialisationWarning?.(),
    ).toMatch(/EMI/i);
  });

  it('rolls back a Quick Transaction ledger write and source balance together on SQLite failure', async () => {
    const { store, balance, stored } = await boot();
    await store.enableBankCashTracking({ 'source-cash': 20000 });
    const balanceBefore = balance('source-cash');
    const storedBalanceBefore = stored('source-cash');
    sql.exec(
      "CREATE TRIGGER fail_quick_transaction_balance BEFORE UPDATE OF encrypted_value ON app_preferences WHEN OLD.key='payment_sources' BEGIN SELECT RAISE(ABORT,'synthetic source persistence failure'); END",
    );
    const transaction = purchase({
      id: 'flash-durable-failure',
      amountMinor: 4500,
      merchant: 'Synthetic market',
    });

    await expect(store.saveManualTransaction(transaction)).rejects.toThrow(
      'synthetic source persistence failure',
    );
    expect(count('card_transactions')).toBe(0);
    expect(count('source_transfers')).toBe(0);
    expect(store.transactions().some((item) => item.id === transaction.id)).toBe(false);
    expect(balance('source-cash')).toBe(balanceBefore);
    expect(stored('source-cash')).toBe(storedBalanceBefore);
  });
  it('rejects clearing enrolled bank identity but preserves legacy blank institutions on unrelated edits', async () => {
    const { store } = await boot();
    const bank = await store.addBankAccount({
      nickname: 'Salary',
      institution: 'ICICI',
      lastDigits: '417',
    });
    const before = financialState();
    for (const institution of ['', '   ', undefined]) {
      await expect(store.updatePaymentSource({ ...bank, institution })).rejects.toThrow(
        'bank name',
      );
      expect(store.paymentSources().find((source) => source.id === bank.id)?.institution).toBe(
        'ICICI',
      );
      expect(financialState()).toEqual(before);
    }
    const legacy = { ...bank, institution: undefined };
    const sources = store
      .paymentSources()
      .map((source) => (source.id === bank.id ? legacy : source));
    await database.run("UPDATE app_preferences SET encrypted_value=? WHERE key='payment_sources'", [
      JSON.stringify(sources),
    ]);
    store.paymentSources.set(sources);
    await store.updatePaymentSource({ ...legacy, nickname: 'Legacy renamed', archived: true });
    expect(store.paymentSources().find((source) => source.id === bank.id)).toMatchObject({
      nickname: 'Legacy renamed',
      archived: true,
    });
    await store.updatePaymentSource({
      ...store.paymentSources().find((source) => source.id === bank.id)!,
      institution: 'ICICI Bank',
    });
    expect(store.paymentSources().find((source) => source.id === bank.id)?.institution).toBe(
      'ICICI Bank',
    );
  });
  it('rolls back duplicate writes, retries the same identity and preserves unapproved evidence copying', async () => {
    const { store, stored } = await boot();
    await store.updatePaymentSource({
      ...store.paymentSources().find((source) => source.kind === 'MEAL')!,
      balanceMinor: 10000,
    });
    const original = purchase({
      id: 'duplicate-original',
      cardId: 'source-meal',
      origin: 'SMS',
      reference: 'synthetic-reference',
      attachmentIds: ['synthetic-receipt'],
    });
    await store.saveManualTransaction(original);
    const before = financialState();
    const visibleBefore = store.transactions();
    sql.exec(
      "CREATE TRIGGER fail_duplicate BEFORE INSERT ON card_transactions WHEN NEW.id <> 'duplicate-original' BEGIN SELECT RAISE(ABORT,'duplicate failure'); END",
    );
    await expect(store.duplicateTransaction(original.id)).rejects.toThrow('duplicate failure');
    const failedId = vi
      .mocked(CapacitorSQLite.run)
      .mock.calls.filter(([options]) =>
        options.statement?.includes('INSERT INTO card_transactions'),
      )
      .at(-1)![0].values![0];
    expect(financialState()).toEqual(before);
    expect(store.transactions()).toEqual(visibleBefore);
    sql.exec('DROP TRIGGER fail_duplicate');
    const [first, second] = await Promise.all([
      store.duplicateTransaction(original.id),
      store.duplicateTransaction(original.id),
    ]);
    expect(first!.id).toBe(second!.id);
    expect(first!.id).toBe(failedId);
    expect(count('card_transactions')).toBe(2);
    expect(stored('source-meal')).toBe(8000);
    expect(first).toMatchObject({
      origin: 'SMS',
      reference: original.reference,
      attachmentIds: original.attachmentIds,
    });
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(
      restarted.transactions().filter((transaction) => transaction.id === first!.id),
    ).toHaveLength(1);
  });

  it('retries an unfunded payment after commit failure once and identifies committed refresh failures', async () => {
    const { store } = await boot();
    store.addCard(card);
    await settle();
    const before = financialState();
    vi.mocked(CapacitorSQLite.commitTransaction).mockRejectedValueOnce(
      new Error('payment commit failure'),
    );
    await expect(store.recordPayment(card.id, 1000, 'Synthetic payment')).rejects.toThrow(
      'payment commit failure',
    );
    const failedId = vi
      .mocked(CapacitorSQLite.run)
      .mock.calls.filter(([options]) =>
        options.statement?.includes('INSERT INTO card_transactions'),
      )
      .at(-1)![0].values![0];
    expect(financialState()).toEqual(before);
    expect(store.transactions()).toHaveLength(0);
    await Promise.all([
      store.recordPayment(card.id, 1000, 'Synthetic payment'),
      store.recordPayment(card.id, 1000, 'Synthetic payment'),
    ]);
    expect(count('card_transactions')).toBe(1);
    expect(rows('SELECT id FROM card_transactions')[0]['id']).toBe(failedId);
    expect(store.cardOutstanding(card.id)).toBe(-1000);
    vi.mocked(CapacitorSQLite.commitTransaction).mockImplementationOnce(async () => {
      sql.exec('COMMIT');
      vi.mocked(CapacitorSQLite.query).mockRejectedValueOnce(
        new Error('Synthetic refresh failure'),
      );
      return { changes: { changes: 0 } };
    });
    await expect(store.recordPayment(card.id, 2000, 'Committed payment')).rejects.toMatchObject({
      name: 'CommittedSaveRefreshError',
    });
    expect(count('card_transactions')).toBe(2);
    expect(
      store.transactions().filter((transaction) => transaction.merchant === 'Committed payment'),
    ).toHaveLength(1);
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(restarted.cardOutstanding(card.id)).toBe(-3000);
  });
  it('rolls back every EMI conversion stage and atomically reschedules and closes without changing the schedule formula', async () => {
    const { store } = await boot();
    store.addCard(card);
    await settle();
    const original = purchase({
      id: 'emi-original',
      cardId: card.id,
      amountMinor: 120000,
      merchant: 'Synthetic purchase',
    });
    await store.saveManualTransaction(original);
    const plan: EmiPlan = {
      id: 'synthetic-plan',
      transactionId: original.id,
      cardId: card.id,
      convertedAmountMinor: original.amountMinor,
      remainingPurchaseMinor: 0,
      tenureMonths: 3,
      annualRateBasisPoints: 1200,
      interestType: 'STANDARD',
      processingFeeMinor: 0,
      taxMinor: 0,
      startDate: today,
      status: 'ACTIVE',
      originalTransactionDate: original.transactionDate,
      originalMerchant: original.merchant,
    };
    const schedule = createEmiSchedule(plan, card);
    const state = () => [
      financialState(),
      rows('SELECT * FROM emi_plans'),
      rows('SELECT * FROM emi_installments ORDER BY installment_number'),
    ];
    const before = state();
    const visibleBefore = store.transactions();
    for (const [table, operation] of [
      ['card_transactions', 'INSERT'],
      ['emi_plans', 'INSERT'],
      ['emi_installments', 'INSERT'],
    ] as const) {
      sql.exec(
        `CREATE TRIGGER fail_emi BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic EMI failure'); END`,
      );
      await expect(store.saveEmiPlan(plan, schedule)).rejects.toThrow('synthetic EMI failure');
      expect(state()).toEqual(before);
      expect(store.transactions()).toEqual(visibleBefore);
      expect(store.emiPlans()).toHaveLength(0);
      sql.exec('DROP TRIGGER fail_emi');
    }
    vi.mocked(CapacitorSQLite.commitTransaction).mockRejectedValueOnce(
      new Error('EMI commit failure'),
    );
    await expect(store.saveEmiPlan(plan, schedule)).rejects.toThrow('EMI commit failure');
    expect(state()).toEqual(before);
    await store.saveEmiPlan(plan, schedule);
    expect(store.emiInstallments()).toMatchObject(schedule);
    expect(
      store
        .transactions()
        .map((item) => item.amountMinor)
        .sort(),
    ).toEqual(schedule.map((item) => item.totalMinor).sort());
    const converted = state();
    const nextPlan = { ...plan, startDate: `${Number(today.slice(0, 4)) + 1}-01-01` };
    const nextSchedule = createEmiSchedule(nextPlan, card);
    sql.exec(
      "CREATE TRIGGER fail_reschedule BEFORE INSERT ON emi_installments WHEN NEW.installment_number=2 BEGIN SELECT RAISE(ABORT,'reschedule failure'); END",
    );
    await expect(store.saveEmiPlan(nextPlan, nextSchedule)).rejects.toThrow('reschedule failure');
    expect(state()).toEqual(converted);
    sql.exec('DROP TRIGGER fail_reschedule');
    await Promise.all([
      store.saveEmiPlan(nextPlan, nextSchedule),
      store.saveEmiPlan(nextPlan, nextSchedule),
    ]);
    expect(count('card_transactions')).toBe(3);
    expect(count('emi_installments')).toBe(3);
    const rescheduled = state();
    const visibleRescheduled = store.transactions();
    sql.exec(
      "CREATE TRIGGER fail_close BEFORE UPDATE ON emi_plans BEGIN SELECT RAISE(ABORT,'closure failure'); END",
    );
    await expect(store.closeEmiPlan(plan.id)).rejects.toThrow('closure failure');
    expect(state()).toEqual(rescheduled);
    expect(store.transactions()).toEqual(visibleRescheduled);
    sql.exec('DROP TRIGGER fail_close');
    await store.closeEmiPlan(plan.id);
    expect(store.emiPlans()[0].status).toBe('CANCELLED');
    expect(store.transactions().every((item) => item.emiCancelled)).toBe(true);
    expect(store.emiInstallments().map((item) => item.totalMinor)).toEqual(
      nextSchedule.map((item) => item.totalMinor),
    );
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(restarted.emiPlans()[0].status).toBe('CANCELLED');
    expect(restarted.transactions()).toEqual(store.transactions());
  });

  it('publishes the committed EMI result and identifies a refresh failure without repeating conversion', async () => {
    const { store } = await boot();
    store.addCard(card);
    await settle();
    const original = purchase({ id: 'emi-refresh', cardId: card.id, amountMinor: 120000 });
    await store.saveManualTransaction(original);
    const plan: EmiPlan = {
      id: 'refresh-plan',
      transactionId: original.id,
      cardId: card.id,
      convertedAmountMinor: original.amountMinor,
      remainingPurchaseMinor: 0,
      tenureMonths: 2,
      annualRateBasisPoints: 0,
      interestType: 'NO_COST',
      processingFeeMinor: 0,
      taxMinor: 0,
      startDate: today,
      status: 'ACTIVE',
    };
    vi.mocked(CapacitorSQLite.commitTransaction).mockImplementationOnce(async () => {
      sql.exec('COMMIT');
      vi.mocked(CapacitorSQLite.query).mockRejectedValueOnce(new Error('EMI refresh failure'));
      return { changes: { changes: 0 } };
    });
    await expect(store.saveEmiPlan(plan, createEmiSchedule(plan, card))).rejects.toMatchObject({
      name: 'CommittedSaveRefreshError',
    });
    expect(count('card_transactions')).toBe(2);
    expect(store.emiPlans()[0].id).toBe(plan.id);
    expect(store.transactions()).toHaveLength(2);
  });
  it.each([
    ['Asia/Kolkata', '2030-10-31T19:00:00Z', '2030-11-01', 1],
    ['UTC', '2030-10-31T19:00:00Z', '2030-11-01', 0],
    ['America/New_York', '2030-10-31T19:00:00Z', '2030-11-01', 0],
    [undefined, '2030-10-31T19:00:00Z', '2030-11-01', 1],
    ['Invalid/Timezone', '2030-10-31T19:00:00Z', '2030-11-01', 1],
    ['Asia/Kolkata', '2030-12-31T19:00:00Z', '2031-01-01', 1],
    ['UTC', '2030-12-31T19:00:00Z', '2031-01-01', 0],
    ['Asia/Kolkata', '2032-02-28T19:00:00Z', '2032-02-29', 1],
    ['Asia/Kolkata', '2031-02-28T19:00:00Z', '2031-03-01', 1],
  ])(
    'evaluates persisted card recurrence in device timezone %s at %s',
    async (zone, instant, due, expected) => {
      const { store } = await boot();
      store.addCard(card);
      await settle();
      const rule: RecurringRule = {
        id: 'local-cutoff-rule',
        cardId: card.id,
        title: 'Local cutoff',
        amountMinor: 1234,
        categoryId: 'other',
        frequency: 'MONTHLY',
        startDate: due,
        nextOccurrenceDate: due,
        status: 'ACTIVE',
        occurrenceLimit: 1,
      };
      await database.run(
        'INSERT INTO recurring_rules(id,card_id,next_occurrence_date,status,payload) VALUES(?,?,?,?,?)',
        [rule.id, card.id, due, rule.status, JSON.stringify(rule)],
      );
      deviceZone(zone);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date(instant));
        await store.materializeRecurringTransactions();
        expect(count('card_transactions')).toBe(expected);
        if (expected)
          expect(store.transactions()[0]).toMatchObject({
            transactionDate: due,
            amountMinor: 1234,
            createdAt: new Date(instant).toISOString(),
            updatedAt: new Date(instant).toISOString(),
          });
        else
          expect(
            rows('SELECT next_occurrence_date FROM recurring_rules')[0]['next_occurrence_date'],
          ).toBe(due);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('preserves explicit recurrence cutoffs and selected historical dates regardless of device timezone', async () => {
    const { store } = await boot();
    store.addCard(card);
    await settle();
    const historical = purchase({
      id: 'local-explicit-history',
      cardId: card.id,
      transactionDate: '2026-08-07',
    });
    await store.saveManualTransaction(historical);
    const saved = store.transactions().find((item) => item.id === historical.id)!;
    const rule: RecurringRule = {
      id: 'explicit-cutoff-rule',
      cardId: card.id,
      title: 'Explicit cutoff',
      amountMinor: 1000,
      categoryId: 'other',
      frequency: 'MONTHLY',
      startDate: '2030-11-01',
      nextOccurrenceDate: '2030-11-01',
      status: 'ACTIVE',
      occurrenceLimit: 1,
    };
    await database.run(
      'INSERT INTO recurring_rules(id,card_id,next_occurrence_date,status,payload) VALUES(?,?,?,?,?)',
      [rule.id, card.id, rule.nextOccurrenceDate, rule.status, JSON.stringify(rule)],
    );
    const zone = deviceZone('Asia/Kolkata');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-10-31T19:00:00Z'));
      await store.materializeRecurringTransactions('2030-10-31');
      expect(count('card_transactions')).toBe(1);
      zone.mockReturnValue({ ...new Intl.DateTimeFormat().resolvedOptions(), timeZone: 'UTC' });
      await store.materializeRecurringTransactions('2030-11-01');
      expect(count('card_transactions')).toBe(2);
      expect(store.transactions().find((item) => item.id === historical.id)).toEqual(saved);
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures the current calendar when queued generation executes and rolls back the local-date batch on failure', async () => {
    const { store } = await boot();
    store.addCard(card);
    await settle();
    const rule: RecurringRule = {
      id: 'queued-cutoff-rule',
      cardId: card.id,
      title: 'Queued cutoff',
      amountMinor: 1000,
      categoryId: 'other',
      frequency: 'MONTHLY',
      startDate: '2030-11-01',
      nextOccurrenceDate: '2030-11-01',
      status: 'ACTIVE',
      occurrenceLimit: 1,
    };
    await database.run(
      'INSERT INTO recurring_rules(id,card_id,next_occurrence_date,status,payload) VALUES(?,?,?,?,?)',
      [rule.id, card.id, rule.nextOccurrenceDate, rule.status, JSON.stringify(rule)],
    );
    deviceZone('Asia/Kolkata');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-10-31T18:29:59Z'));
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const blocker = database.atomic(async () => {
        started();
        await gate;
      });
      await entered;
      const pending = store.materializeRecurringTransactions();
      vi.setSystemTime(new Date('2030-10-31T18:30:00Z'));
      release();
      await Promise.all([blocker, pending]);
      expect(count('card_transactions')).toBe(1);
      expect(store.transactions()[0]).toMatchObject({
        transactionDate: '2030-11-01',
        createdAt: '2030-10-31T18:30:00.000Z',
        updatedAt: '2030-10-31T18:30:00.000Z',
      });
      const nextRule: RecurringRule = { ...rule, id: 'failed-local-rule' };
      await database.run(
        'INSERT INTO recurring_rules(id,card_id,next_occurrence_date,status,payload) VALUES(?,?,?,?,?)',
        [
          nextRule.id,
          card.id,
          nextRule.nextOccurrenceDate,
          nextRule.status,
          JSON.stringify(nextRule),
        ],
      );
      const before = financialState();
      sql.exec(
        "CREATE TRIGGER fail_local_recurrence BEFORE INSERT ON card_transactions BEGIN SELECT RAISE(ABORT,'local recurrence failure'); END",
      );
      await expect(store.materializeRecurringTransactions()).rejects.toThrow(
        'local recurrence failure',
      );
      expect(financialState()).toEqual(before);
      expect(
        rows('SELECT next_occurrence_date FROM recurring_rules WHERE id=?', [nextRule.id])[0][
          'next_occurrence_date'
        ],
      ).toBe('2030-11-01');
      sql.exec('DROP TRIGGER fail_local_recurrence');
      await Promise.all([
        store.materializeRecurringTransactions(),
        store.materializeRecurringTransactions(),
      ]);
      expect(count('card_transactions')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps card occurrences idempotent across a repeated DST hour, timezone changes, relaunch and encrypted restore', async () => {
    const { store } = await boot();
    store.addCard({ ...card, excludeStatementDayTransactions: true });
    await settle();
    const rule: RecurringRule = {
      id: 'travelling-rule',
      cardId: card.id,
      title: 'Travelling cutoff',
      amountMinor: 1000,
      categoryId: 'other',
      frequency: 'MONTHLY',
      startDate: '2026-11-01',
      nextOccurrenceDate: '2026-11-01',
      status: 'ACTIVE',
      occurrenceLimit: 2,
    };
    await database.run(
      'INSERT INTO recurring_rules(id,card_id,next_occurrence_date,status,payload) VALUES(?,?,?,?,?)',
      [rule.id, card.id, rule.nextOccurrenceDate, rule.status, JSON.stringify(rule)],
    );
    const zone = deviceZone('America/New_York');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-01T05:30:00Z'));
      await store.materializeRecurringTransactions();
      expect(count('card_transactions')).toBe(1);
      const saved = store.transactions()[0];
      vi.setSystemTime(new Date('2026-11-01T06:30:00Z'));
      await store.materializeRecurringTransactions();
      expect(count('card_transactions')).toBe(1);
      vi.setSystemTime(new Date('2026-11-30T19:00:00Z'));
      await store.materializeRecurringTransactions();
      expect(count('card_transactions')).toBe(1);
      zone.mockReturnValue({
        ...new Intl.DateTimeFormat().resolvedOptions(),
        timeZone: 'Asia/Kolkata',
      });
      await store.materializeRecurringTransactions();
      expect(count('card_transactions')).toBe(2);
      expect(store.transactions().find((item) => item.id === saved.id)).toEqual(saved);
      const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
      await restarted.initialisePreferences();
      expect(count('card_transactions')).toBe(2);
      const before = [financialState(), rows('SELECT * FROM recurring_rules ORDER BY id')];
      vi.stubGlobal('crypto', webcrypto);
      vi.stubGlobal('Blob', NodeBlob);
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-local-calendar-passphrase');
      await backups.restore(backup.contents, 'synthetic-local-calendar-passphrase');
      const restored = TestBed.runInInjectionContext(() => new CardNestStore());
      await restored.initialisePreferences();
      expect([financialState(), rows('SELECT * FROM recurring_rules ORDER BY id')]).toEqual(before);
      expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['Asia/Kolkata', '2030-10-31T19:00:00Z', '2030-11-01', false],
    ['UTC', '2030-10-31T19:00:00Z', '2030-11-01', true],
    ['America/New_York', '2030-10-31T19:00:00Z', '2030-11-01', true],
    [undefined, '2030-10-31T19:00:00Z', '2030-11-01', false],
    ['Invalid/Timezone', '2030-10-31T19:00:00Z', '2030-11-01', false],
    ['Asia/Kolkata', '2030-12-31T19:00:00Z', '2031-01-01', false],
    ['UTC', '2030-12-31T19:00:00Z', '2031-01-01', true],
    ['Asia/Kolkata', '2032-02-29T19:00:00Z', '2032-03-01', false],
  ])(
    'closes EMI using device month %s at %s while preserving installment data',
    async (zone, instant, startDate, firstCancelled) => {
      const { store } = await boot();
      store.addCard(card);
      await settle();
      const original = purchase({
        id: 'local-month-emi',
        cardId: card.id,
        amountMinor: 120000,
        transactionDate: startDate,
      });
      await store.saveManualTransaction(original);
      const plan: EmiPlan = {
        id: 'local-month-plan',
        transactionId: original.id,
        cardId: card.id,
        convertedAmountMinor: original.amountMinor,
        remainingPurchaseMinor: 0,
        tenureMonths: 3,
        annualRateBasisPoints: 1200,
        interestType: 'STANDARD',
        processingFeeMinor: 0,
        taxMinor: 0,
        startDate,
        status: 'ACTIVE',
      };
      const schedule = createEmiSchedule(plan, card).map((item, index) => ({
        ...item,
        paid: index === 0,
      }));
      await store.saveEmiPlan(plan, schedule);
      const beforeInstallments = rows('SELECT * FROM emi_installments ORDER BY installment_number');
      const beforeTransactions = store.transactions();
      deviceZone(zone);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date(instant));
        await store.closeEmiPlan(plan.id);
        expect(rows('SELECT * FROM emi_installments ORDER BY installment_number')).toEqual(
          beforeInstallments,
        );
        expect(store.emiPlans()[0]).toMatchObject({
          status: 'CANCELLED',
          closedAt: new Date(instant).toISOString(),
        });
        for (const transaction of store.transactions()) {
          const previous = beforeTransactions.find((item) => item.id === transaction.id)!;
          const cancelled = transaction.emiInstallmentNumber === 1 ? firstCancelled : true;
          expect(transaction).toEqual(
            cancelled
              ? { ...previous, emiCancelled: true, updatedAt: new Date(instant).toISOString() }
              : previous,
          );
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('rolls back a device-local EMI closure commit and retries with one captured instant', async () => {
    const { store } = await boot();
    store.addCard(card);
    await settle();
    const original = purchase({
      id: 'local-close-failure',
      cardId: card.id,
      amountMinor: 120000,
      transactionDate: '2030-11-01',
    });
    await store.saveManualTransaction(original);
    const plan: EmiPlan = {
      id: 'local-close-failure-plan',
      transactionId: original.id,
      cardId: card.id,
      convertedAmountMinor: original.amountMinor,
      remainingPurchaseMinor: 0,
      tenureMonths: 2,
      annualRateBasisPoints: 0,
      interestType: 'NO_COST',
      processingFeeMinor: 0,
      taxMinor: 0,
      startDate: '2030-11-01',
      status: 'ACTIVE',
    };
    await store.saveEmiPlan(plan, createEmiSchedule(plan, card));
    const before = [
      financialState(),
      rows('SELECT * FROM emi_plans'),
      rows('SELECT * FROM emi_installments'),
    ];
    const visible = store.transactions();
    deviceZone('Asia/Kolkata');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-11-30T18:29:59Z'));
      vi.mocked(CapacitorSQLite.commitTransaction).mockRejectedValueOnce(
        new Error('local closure commit failure'),
      );
      await expect(store.closeEmiPlan(plan.id)).rejects.toThrow('local closure commit failure');
      expect([
        financialState(),
        rows('SELECT * FROM emi_plans'),
        rows('SELECT * FROM emi_installments'),
      ]).toEqual(before);
      expect(store.transactions()).toEqual(visible);
      const query = vi.mocked(CapacitorSQLite.query).getMockImplementation()!;
      vi.mocked(CapacitorSQLite.query).mockImplementation(async (options) => {
        if (options.statement?.startsWith('SELECT payload FROM card_transactions ORDER BY'))
          vi.setSystemTime(new Date('2030-11-30T18:30:00Z'));
        return query(options);
      });
      await store.closeEmiPlan(plan.id);
      expect(store.emiPlans()[0].closedAt).toBe('2030-11-30T18:29:59.000Z');
      expect(
        store.transactions().find((item) => item.emiInstallmentNumber === 1)?.emiCancelled,
      ).not.toBe(true);
      expect(store.transactions().find((item) => item.emiInstallmentNumber === 2)).toMatchObject({
        emiCancelled: true,
        updatedAt: '2030-11-30T18:29:59.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the deferred non-card cutoff unchanged while card defaults resolve afresh', async () => {
    const { store } = await boot();
    const deferred = store as unknown as {
      materializeNonCardRecurringTransactions(asOf: string): void;
    };
    const legacy = vi.spyOn(deferred, 'materializeNonCardRecurringTransactions');
    await store.materializeRecurringTransactions();
    const originalCutoff = legacy.mock.calls[0][0];
    const before = financialState();
    deviceZone('Asia/Kolkata');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-10-31T19:00:00Z'));
      await store.materializeRecurringTransactions();
      expect(legacy).toHaveBeenLastCalledWith(originalCutoff);
      await store.materializeRecurringTransactions('2030-11-02');
      expect(legacy).toHaveBeenLastCalledWith('2030-11-02');
      expect(financialState()).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('atomically generates legacy card recurrence with rollback, concurrent retry, month-end limits and restart safety', async () => {
    const { store } = await boot();
    store.addCard(card);
    await settle();
    const rule: RecurringRule = {
      id: 'legacy:monthly-rule',
      cardId: card.id,
      title: 'Synthetic repeat',
      amountMinor: 1234,
      categoryId: 'other',
      frequency: 'MONTHLY',
      startDate: '2026-01-31',
      nextOccurrenceDate: '2026-01-31',
      status: 'ACTIVE',
      occurrenceLimit: 3,
    };
    await database.run(
      'INSERT INTO recurring_rules(id,card_id,next_occurrence_date,status,payload) VALUES(?,?,?,?,?)',
      [rule.id, card.id, rule.nextOccurrenceDate, rule.status, JSON.stringify(rule)],
    );
    store.recurringRules.set([rule]);
    const before = [financialState(), rows('SELECT * FROM recurring_rules')];
    for (const trigger of [
      "BEFORE INSERT ON card_transactions WHEN NEW.transaction_date='2026-02-28'",
      'BEFORE UPDATE ON recurring_rules',
    ]) {
      sql.exec(
        `CREATE TRIGGER fail_recurring ${trigger} BEGIN SELECT RAISE(ABORT,'recurrence failure'); END`,
      );
      await expect(store.materializeRecurringTransactions('2026-03-31')).rejects.toThrow(
        'recurrence failure',
      );
      expect([financialState(), rows('SELECT * FROM recurring_rules')]).toEqual(before);
      expect(store.recurringRules()).toEqual([rule]);
      expect(store.transactions()).toHaveLength(0);
      sql.exec('DROP TRIGGER fail_recurring');
    }
    vi.mocked(CapacitorSQLite.commitTransaction).mockRejectedValueOnce(
      new Error('recurrence commit failure'),
    );
    await expect(store.materializeRecurringTransactions('2026-03-31')).rejects.toThrow(
      'recurrence commit failure',
    );
    expect([financialState(), rows('SELECT * FROM recurring_rules')]).toEqual(before);
    vi.mocked(CapacitorSQLite.commitTransaction).mockImplementationOnce(async () => {
      sql.exec('COMMIT');
      vi.mocked(CapacitorSQLite.query).mockRejectedValueOnce(
        new Error('Recurring refresh failure'),
      );
      return { changes: { changes: 0 } };
    });
    await expect(store.materializeRecurringTransactions('2026-03-31')).rejects.toMatchObject({
      name: 'CommittedSaveRefreshError',
    });
    expect(count('card_transactions')).toBe(3);
    expect(store.recurringRules()[0].status).toBe('COMPLETED');
    await Promise.all([
      store.materializeRecurringTransactions('2026-03-31'),
      store.materializeRecurringTransactions('2026-03-31'),
    ]);
    expect(
      rows('SELECT transaction_date,amount_minor FROM card_transactions ORDER BY transaction_date'),
    ).toEqual([
      { transaction_date: '2026-01-31', amount_minor: 1234 },
      { transaction_date: '2026-02-28', amount_minor: 1234 },
      { transaction_date: '2026-03-31', amount_minor: 1234 },
    ]);
    expect(store.recurringRules()[0]).toMatchObject({
      id: rule.id,
      status: 'COMPLETED',
      nextOccurrenceDate: undefined,
    });
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    await restarted.materializeRecurringTransactions('2026-12-31');
    expect(count('card_transactions')).toBe(3);
    expect(restarted.recurringRules()[0].id).toBe(rule.id);
  });

  it('creates a card entry and schedule together and never rewinds progress when a concurrent rule edit follows generation', async () => {
    const { store } = await boot();
    store.addCard(card);
    await settle();
    const rule: RecurringRule = {
      id: 'initial-schedule',
      cardId: card.id,
      title: 'Initial repeat',
      amountMinor: 1000,
      categoryId: 'other',
      frequency: 'MONTHLY',
      startDate: '2026-01-31',
      nextOccurrenceDate: '2026-02-28',
      status: 'ACTIVE',
    };
    const first = purchase({
      id: 'initial-recurring',
      cardId: card.id,
      transactionDate: rule.startDate,
      recurringRuleId: rule.id,
      generatedOccurrenceDate: rule.startDate,
    });
    sql.exec(
      "CREATE TRIGGER fail_initial_rule BEFORE INSERT ON recurring_rules BEGIN SELECT RAISE(ABORT,'initial schedule failure'); END",
    );
    const before = financialState();
    await expect(store.saveManualTransaction(first, '', false, rule)).rejects.toThrow(
      'initial schedule failure',
    );
    expect(financialState()).toEqual(before);
    expect(store.transactions()).toHaveLength(0);
    sql.exec('DROP TRIGGER fail_initial_rule');
    await store.saveManualTransaction(first, '', false, rule);
    await Promise.all([
      store.materializeRecurringTransactions('2026-02-28'),
      store.updateRecurringRule(rule.id, 2000),
    ]);
    expect(store.recurringRules()[0]).toMatchObject({
      nextOccurrenceDate: '2026-03-31',
      amountMinor: 2000,
    });
    await store.materializeRecurringTransactions('2026-03-31');
    expect(
      rows('SELECT transaction_date,amount_minor FROM card_transactions ORDER BY transaction_date'),
    ).toEqual([
      { transaction_date: '2026-01-31', amount_minor: 1000 },
      { transaction_date: '2026-02-28', amount_minor: 1000 },
      { transaction_date: '2026-03-31', amount_minor: 2000 },
    ]);
    await store.terminateRecurringRule(rule.id);
    await store.materializeRecurringTransactions('2027-12-31');
    expect(count('card_transactions')).toBe(3);
  });
  it('uses configured card currency and India date for new payments and rejects foreign bank funding without writes', async () => {
    const { store } = await boot();
    store.addCard({ ...card, currencyCode: 'USD' });
    await settle();
    const source = await store.addBankAccount({
      nickname: 'Funding',
      institution: 'ICICI',
      lastDigits: '417',
    });
    await store.enableBankCashTracking({ [source.id]: 100000 });
    await store.setCardSettlementFunding(true);
    const before = financialState();
    await expect(
      store.recordFundedPayment(card.id, 1000, 'Unsupported', source.id),
    ).rejects.toThrow('only for INR');
    expect(financialState()).toEqual(before);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-27T20:00:00.000Z'));
      await store.recordPayment(card.id, 1234, 'Foreign unfunded');
    } finally {
      vi.useRealTimers();
    }
    const payment = store
      .transactions()
      .find((transaction) => transaction.merchant === 'Foreign unfunded')!;
    expect(payment).toMatchObject({
      currencyCode: 'USD',
      transactionDate: '2026-10-28',
      amountMinor: 1234,
    });
    const rule: RecurringRule = {
      id: 'foreign-recurring',
      cardId: card.id,
      title: 'Foreign repeat',
      amountMinor: 5678,
      categoryId: 'other',
      frequency: 'MONTHLY',
      startDate: '2026-01-31',
      nextOccurrenceDate: '2026-01-31',
      status: 'ACTIVE',
      occurrenceLimit: 2,
    };
    await store.addRecurringRule(rule);
    expect(
      store
        .transactions()
        .filter((transaction) => transaction.recurringRuleId === rule.id)
        .map((transaction) => transaction.currencyCode),
    ).toEqual(['USD', 'USD']);
    expect(store.transactions().find((transaction) => transaction.id === payment.id)).toEqual(
      payment,
    );
  });
  it('shows no false UI success for failed payment or duplicate and closes a committed payment after refresh failure', async () => {
    const { store } = await boot();
    store.addCard(card);
    await settle();
    const original = purchase({ id: 'ui-original', cardId: card.id, amountMinor: 5000 });
    await store.saveManualTransaction(original);
    const cards = TestBed.createComponent(CardsPage);
    const page = cards.componentInstance;
    const snack = vi.spyOn(TestBed.inject(SnackbarService), 'show');
    page.paymentCard.set(card);
    page.paymentAmount.set('10');
    page.paymentConfirmationOpen.set(true);
    sql.exec(
      "CREATE TRIGGER fail_ui_payment BEFORE INSERT ON card_transactions WHEN NEW.type='PAYMENT' BEGIN SELECT RAISE(ABORT,'UI payment failure'); END",
    );
    await page.confirmPayment();
    expect(snack).not.toHaveBeenCalled();
    expect(page.paymentError()).toBe('UI payment failure');
    expect(page.paymentCard()).toEqual(card);
    expect(count('card_transactions')).toBe(1);
    sql.exec('DROP TRIGGER fail_ui_payment');
    await Promise.all([page.confirmPayment(), page.confirmPayment()]);
    expect(count('card_transactions')).toBe(2);
    expect(page.paymentCard()).toBeNull();
    expect(snack).toHaveBeenCalledOnce();
    snack.mockClear();
    page.paymentCard.set(card);
    page.paymentAmount.set('20');
    vi.mocked(CapacitorSQLite.commitTransaction).mockImplementationOnce(async () => {
      sql.exec('COMMIT');
      vi.mocked(CapacitorSQLite.query).mockRejectedValueOnce(new Error('UI refresh failure'));
      return { changes: { changes: 0 } };
    });
    await page.confirmPayment();
    expect(page.paymentCard()).toBeNull();
    expect(snack).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Transaction saved'),
      'WARNING',
    );
    await page.confirmPayment();
    expect(count('card_transactions')).toBe(3);
    snack.mockClear();
    const transactions = TestBed.createComponent(TransactionsPage);
    sql.exec(
      "CREATE TRIGGER fail_ui_duplicate BEFORE INSERT ON card_transactions WHEN NEW.type='PURCHASE' BEGIN SELECT RAISE(ABORT,'UI duplicate failure'); END",
    );
    await transactions.componentInstance.duplicate(original);
    expect(snack).toHaveBeenCalledExactlyOnceWith('UI duplicate failure', 'WARNING');
    expect(count('card_transactions')).toBe(3);
    sql.exec('DROP TRIGGER fail_ui_duplicate');
    await transactions.componentInstance.duplicate(original);
    expect(count('card_transactions')).toBe(4);
    cards.destroy();
    transactions.destroy();
  });

  it('retries only the failed card after a partially completed linked reminder payment', async () => {
    const { store } = await boot();
    const second = { ...card, id: 'fiction-second', nickname: 'Second' };
    store.addCard(card);
    store.addCard(second);
    await settle();
    await store.saveManualTransaction(
      purchase({ id: 'linked-first', cardId: card.id, amountMinor: 1000 }),
    );
    await store.saveManualTransaction(
      purchase({ id: 'linked-second', cardId: second.id, amountMinor: 2000 }),
    );
    const fixture = TestBed.createComponent(RemindersPage);
    const page = fixture.componentInstance;
    vi.spyOn(page, 'linkedAccountCards').mockReturnValue([card, second]);
    page.linkedPaymentCandidate.set({ card, mode: 'OUTSTANDING' });
    const snack = vi.spyOn(TestBed.inject(SnackbarService), 'show');
    sql.exec(
      "CREATE TRIGGER fail_second_payment BEFORE INSERT ON card_transactions WHEN NEW.type='PAYMENT' AND NEW.card_id='fiction-second' BEGIN SELECT RAISE(ABORT,'Second card failure'); END",
    );
    await page.confirmLinkedPayment();
    expect(snack).toHaveBeenCalledExactlyOnceWith('Second card failure', 'WARNING');
    expect(rows("SELECT card_id,amount_minor FROM card_transactions WHERE type='PAYMENT'")).toEqual(
      [{ card_id: card.id, amount_minor: 1000 }],
    );
    expect(page.linkedPaymentCandidate()).not.toBeNull();
    sql.exec('DROP TRIGGER fail_second_payment');
    await page.confirmLinkedPayment();
    expect(
      rows(
        "SELECT card_id,amount_minor FROM card_transactions WHERE type='PAYMENT' ORDER BY card_id",
      ),
    ).toEqual([
      { card_id: card.id, amount_minor: 1000 },
      { card_id: second.id, amount_minor: 2000 },
    ]);
    expect(page.linkedPaymentCandidate()).toBeNull();
    expect(store.cardOutstanding(card.id)).toBe(0);
    expect(store.cardOutstanding(second.id)).toBe(0);
    fixture.destroy();
  });

  it('round trips newly durable EMI, recurring entries and unfunded payments through encrypted backup without replay', async () => {
    const { store } = await boot();
    store.addCard({ ...card, excludeStatementDayTransactions: true });
    await settle();
    const original = purchase({
      id: 'durable-backup-original',
      cardId: card.id,
      amountMinor: 120000,
    });
    await store.saveManualTransaction(original);
    const plan: EmiPlan = {
      id: 'durable-backup-plan',
      transactionId: original.id,
      cardId: card.id,
      convertedAmountMinor: original.amountMinor,
      remainingPurchaseMinor: 0,
      tenureMonths: 2,
      annualRateBasisPoints: 0,
      interestType: 'NO_COST',
      processingFeeMinor: 0,
      taxMinor: 0,
      startDate: today,
      status: 'ACTIVE',
    };
    await store.saveEmiPlan(plan, createEmiSchedule(plan, card));
    await store.recordPayment(card.id, 5000, 'Backup payment');
    await store.addRecurringRule({
      id: 'durable-backup-rule',
      cardId: card.id,
      title: 'Backup repeat',
      amountMinor: 1000,
      categoryId: 'other',
      frequency: 'MONTHLY',
      startDate: '2026-01-31',
      nextOccurrenceDate: '2026-01-31',
      status: 'ACTIVE',
      occurrenceLimit: 2,
    });
    const before = [
      financialState(),
      rows('SELECT * FROM emi_plans ORDER BY id'),
      rows('SELECT * FROM emi_installments ORDER BY id'),
      rows('SELECT * FROM recurring_rules ORDER BY id'),
    ];
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    try {
      const backups = TestBed.inject(BackupService);
      const backup = await backups.create('synthetic-durable-backup-passphrase');
      sql.exec(
        "CREATE TRIGGER fail_durable_restore BEFORE INSERT ON emi_installments BEGIN SELECT RAISE(ABORT,'durable restore failure'); END",
      );
      await expect(
        backups.restore(backup.contents, 'synthetic-durable-backup-passphrase'),
      ).rejects.toThrow('durable restore failure');
      expect([
        financialState(),
        rows('SELECT * FROM emi_plans ORDER BY id'),
        rows('SELECT * FROM emi_installments ORDER BY id'),
        rows('SELECT * FROM recurring_rules ORDER BY id'),
      ]).toEqual(before);
      sql.exec('DROP TRIGGER fail_durable_restore');
      await backups.restore(backup.contents, 'synthetic-durable-backup-passphrase');
      const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
      await restarted.initialisePreferences();
      expect([
        financialState(),
        rows('SELECT * FROM emi_plans ORDER BY id'),
        rows('SELECT * FROM emi_installments ORDER BY id'),
        rows('SELECT * FROM recurring_rules ORDER BY id'),
      ]).toEqual(before);
      expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(restarted.emiPlans()[0].id).toBe(plan.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('guards Bank/Cash balances and baselines while preserving wallet edits and audited balance operations', async () => {
    const { store, stored } = await boot();
    await store.enableBankCashTracking({ 'source-cash': 10000, 'source-debit': 20000 });
    const before = financialState();
    for (const source of store
      .paymentSources()
      .filter((row) => row.kind === 'CASH' || row.kind === 'DEBIT')) {
      for (const patch of [
        { balanceMinor: 30000 },
        { balanceMinor: undefined },
        { balanceSnapshotMinor: 30000 },
        { balanceCutoverAt: undefined },
        { balanceCutoverReason: 'MANUAL' as const },
      ]) {
        await expect(store.updatePaymentSource({ ...source, ...patch })).rejects.toThrow(
          'Set Current Balance',
        );
        expect(financialState()).toEqual(before);
      }
      await store.updatePaymentSource({ ...source, nickname: `${source.nickname} renamed` });
    }
    await store.setSourceBalance('source-cash', 15000);
    expect(stored('source-cash')).toBe(15000);
    expect(count('source_balance_adjustments')).toBe(3);
    for (const kind of ['MEAL', 'FASTAG'] as const) {
      if (kind === 'FASTAG')
        await store.addWallet({
          id: 'synthetic-tag',
          kind,
          nickname: 'Tag',
          noLimit: false,
          autoLoad: false,
          balanceMinor: 0,
          archived: false,
        });
      const wallet = store.paymentSources().find((source) => source.kind === kind)!;
      await store.updatePaymentSource({ ...wallet, balanceMinor: 25000 });
      expect(stored(wallet.id)).toBe(25000);
    }
    const beforeFailure = store.paymentSources();
    sql.exec(
      "CREATE TRIGGER fail_guarded_identity BEFORE UPDATE ON app_preferences WHEN OLD.key='payment_sources' BEGIN SELECT RAISE(ABORT,'synthetic identity failure'); END",
    );
    await expect(
      store.updatePaymentSource({ ...beforeFailure[0], nickname: 'Not saved' }),
    ).rejects.toThrow('synthetic identity failure');
    expect(store.paymentSources()).toEqual(beforeFailure);
  });
  it('distinguishes a committed purchase from a failed refresh and cannot double-post its balance on retry/restart', async () => {
    const { store, balance, stored } = await boot();
    await store.enableBankCashTracking({ 'source-cash': 20000 });
    const item = purchase({
      id: 'committed-refresh-failure',
      amountMinor: 4500,
      balanceTiming: 'AFTER_BASELINE',
    });
    const original = database.query.bind(database);
    const read = vi.spyOn(database, 'query').mockImplementation(async (statement, values) => {
      if (statement.startsWith('SELECT payload FROM card_transactions ORDER BY'))
        throw new Error('Synthetic refresh failure');
      return original(statement, values);
    });
    await expect(store.saveManualTransaction(item)).rejects.toMatchObject({
      name: 'CommittedSaveRefreshError',
      transactionId: item.id,
    });
    expect(count('card_transactions')).toBe(1);
    expect(stored('source-cash')).toBe(15500);
    expect(balance('source-cash')).toBe(15500);
    read.mockRestore();
    await store.saveManualTransaction(item);
    expect(count('card_transactions')).toBe(1);
    expect(stored('source-cash')).toBe(15500);
    const restarted = TestBed.runInInjectionContext(() => new CardNestStore());
    await restarted.initialisePreferences();
    expect(restarted.transactions().filter((row) => row.id === item.id)).toHaveLength(1);
    expect(restarted.paymentSources().find((row) => row.id === 'source-cash')?.balanceMinor).toBe(
      15500,
    );
  });
  it('rolls back a failed commit, retries the same purchase and commits its effect exactly once', async () => {
    const { store, stored } = await boot();
    await store.enableBankCashTracking({ 'source-cash': 20000 });
    const item = purchase({
      id: 'commit-retry',
      amountMinor: 4500,
      balanceTiming: 'AFTER_BASELINE',
    });
    vi.mocked(CapacitorSQLite.commitTransaction).mockRejectedValueOnce(new Error('Commit failed'));
    await expect(store.saveManualTransaction(item)).rejects.toThrow('Commit failed');
    expect(count('card_transactions')).toBe(0);
    expect(stored('source-cash')).toBe(20000);
    await Promise.all([store.saveManualTransaction(item), store.saveManualTransaction(item)]);
    expect(count('card_transactions')).toBe(1);
    expect(stored('source-cash')).toBe(15500);
  });
  it('reports transfer refresh failure as already committed and does not apply funding twice', async () => {
    const { store, stored } = await boot();
    store.addCard(card);
    await settle();
    const source = await store.addBankAccount({
      nickname: 'Funding',
      institution: 'ICICI',
      lastDigits: '00123',
    });
    await store.enableBankCashTracking({ [source.id]: 100000 });
    await store.setCardSettlementFunding(true);
    await store.recordFundedPayment(card.id, 10000, 'Funded payment', source.id);
    const item = {
      ...store.transactions().find((row) => row.merchant === 'Funded payment')!,
      amountMinor: 12000,
    };
    const original = database.query.bind(database);
    const read = vi.spyOn(database, 'query').mockImplementation(async (statement, values) => {
      if (statement.startsWith('SELECT payload FROM source_transfers'))
        throw new Error('Transfer refresh failed');
      return original(statement, values);
    });
    await expect(store.saveManualTransaction(item)).rejects.toMatchObject({
      name: 'CommittedSaveRefreshError',
      transactionId: item.id,
    });
    expect(stored(source.id)).toBe(88000);
    expect(count('source_transfers')).toBe(1);
    read.mockRestore();
    await store.saveManualTransaction(item);
    expect(stored(source.id)).toBe(88000);
    expect(count('source_transfers')).toBe(1);
    expect(count('card_transactions')).toBe(1);
  });
  it('rejects a mislabeled foreign-card currency without changing finance and accepts the actual card currency', async () => {
    const { store } = await boot();
    store.addCard({ ...card, currencyCode: 'USD' });
    await settle();
    const item = purchase({ id: 'foreign-card', cardId: card.id, amountMinor: 1234 });
    await expect(store.saveManualTransaction(item)).rejects.toThrow('currency differs');
    expect(count('card_transactions')).toBe(0);
    await store.saveManualTransaction({ ...item, currencyCode: 'USD' });
    expect(rows('SELECT currency_code,amount_minor FROM card_transactions')).toEqual([
      { currency_code: 'USD', amount_minor: 1234 },
    ]);
  });
  it('does not publish an uncommitted source identity or preserve it after a failed write', async () => {
    const { store } = await boot();
    const source = await store.addBankAccount({
      nickname: 'Original',
      institution: 'ICICI',
      lastDigits: '00123',
    });
    await store.enableBankCashTracking({ [source.id]: 12000 });
    const activity = TestBed.inject(BankActivityService);
    await activity.reload();
    const profilesBefore = rows('SELECT * FROM bank_activity_profiles');
    const moneyBefore = financialState();
    const before = store.paymentSources();
    sql.exec(
      "CREATE TRIGGER fail_source_identity BEFORE UPDATE ON app_preferences WHEN OLD.key='payment_sources' BEGIN SELECT RAISE(ABORT,'identity write failure'); END",
    );
    const pending = store.updatePaymentSource({
      ...source,
      nickname: 'Uncommitted',
      lastDigits: '00007',
    });
    const reconciliation = activity.reload();
    expect(store.paymentSources()).toEqual(before);
    await expect(pending).rejects.toThrow('identity write failure');
    await reconciliation;
    expect(store.paymentSources()).toEqual(before);
    expect(rows('SELECT * FROM bank_activity_profiles')).toEqual(profilesBefore);
    expect(financialState()).toEqual(moneyBefore);
  });

  it('approves an ICICI-style UPI debit as spending with tracking off, keeping bank identity and no balance', async () => {
    const { store, review, balance } = await boot();
    expect(store.bankCashTracking().enabled).toBe(false);
    const candidate = await stage(evidence());
    await review.approveBank(candidate, {
      categoryId: 'groceries',
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

  it('revalidates Bank/UPI categories atomically at approval time', async () => {
    const { store, review } = await boot();
    await database.run("UPDATE categories SET archived=1 WHERE id='groceries'");
    const automatic = await stage(evidence({ id: 'd'.repeat(64), reference: '735182094621' }));
    await review.approveBank(automatic, {
      purpose: 'PURCHASE',
      sourceId: 'source-debit',
      amountMinor: 45000,
      description: 'HILL FARM MEATS',
      transactionDate: today,
      categoryId: 'groceries',
      categoryOverridden: false,
      allowSeparate: true,
    });
    expect(store.transactions()[0].categoryId).toBe('other');

    const staleExplicit = await stage(evidence({ id: 'e'.repeat(64), reference: '735182094622' }));
    await expect(
      review.approveBank(staleExplicit, {
        purpose: 'PURCHASE',
        sourceId: 'source-debit',
        amountMinor: 45000,
        description: 'HILL FARM MEATS',
        transactionDate: today,
        categoryId: 'groceries',
        categoryOverridden: true,
        allowSeparate: true,
      }),
    ).rejects.toThrow('selected category is unavailable or incompatible');
    expect(count('card_transactions')).toBe(1);

    const validExplicit = await stage(evidence({ id: 'f'.repeat(64), reference: '735182094623' }));
    await review.approveBank(validExplicit, {
      purpose: 'PURCHASE',
      sourceId: 'source-debit',
      amountMinor: 45000,
      description: 'HILL FARM MEATS',
      transactionDate: today,
      categoryId: 'dining',
      categoryOverridden: true,
      allowSeparate: true,
    });
    expect(
      store.transactions().find((transaction) => transaction.id === `sms-${validExplicit.id}`)
        ?.categoryId,
    ).toBe('dining');
    expect(count('card_transactions')).toBe(2);
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
    await store.recordPayment(card.id, 10_000, 'Unfunded payment');
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

  it('matches an ordinary Bank/UPI purchase without another debit and confirms a separate purchase exactly once', async () => {
    const { store, review, balance } = await boot();
    // Keep explicit events after the confirmed balance regardless of the machine's clock time.
    const eventDate = indiaTodayIso(new Date(Date.now() + 86400000));
    const bank = await store.addBankAccount({
      nickname: 'Daily bank',
      institution: 'ICICI',
      lastDigits: '417',
    });
    await store.enableBankCashTracking({ [bank.id]: 100000 });
    const existing = purchase({
      cardId: bank.id,
      amountMinor: 5000,
      transactionDate: eventDate,
      transactionTime: '17:30',
      balanceTiming: 'AFTER_BASELINE',
    });
    store.addTransaction(existing);
    await settle();
    const afterManual = balance(bank.id);
    const item = evidence({
      reference: undefined,
      amountMinor: 5000,
      eventTimeExplicit: true,
      eventTime: '17:30:00',
      eventDate,
      eventAt: `${eventDate}T12:00:00Z`,
    });
    const candidate = await stage(item);
    const approval = {
      purpose: 'PURCHASE' as const,
      sourceId: bank.id,
      amountMinor: 5000,
      description: 'Daily milk',
      transactionDate: eventDate,
      baselineTiming: 'AFTER_BASELINE' as const,
    };
    await review.approveBank(candidate, { ...approval, existingId: existing.id });
    expect(count('card_transactions')).toBe(1);
    expect(balance(bank.id)).toBe(afterManual);
    const separate = await stage({ ...item, id: 'b'.repeat(64) });
    await expect(review.approveBank(separate, approval)).rejects.toThrow('Match it');
    await Promise.all([
      review.approveBank(separate, { ...approval, allowSeparate: true }),
      review.approveBank(separate, { ...approval, allowSeparate: true }),
    ]);
    expect(count('card_transactions')).toBe(2);
    expect(balance(bank.id)).toBe(afterManual! - 5000);
    expect(
      rows('SELECT decision FROM sms_reconciliation WHERE candidate_id=?', [separate.id])[0][
        'decision'
      ],
    ).toBe('BANK_PURCHASE_CONFIRMED_SEPARATE');
    await review.approveBank(separate, { ...approval, allowSeparate: true });
    expect(count('card_transactions')).toBe(2);
    expect(balance(bank.id)).toBe(afterManual! - 5000);
  });
  it('never bypasses a recorded Bank/UPI reference using separate confirmation or edited amounts', async () => {
    const { store, review, balance } = await boot();
    const bank = await store.addBankAccount({
      nickname: 'Daily bank',
      institution: 'ICICI',
      lastDigits: '417',
    });
    await store.enableBankCashTracking({ [bank.id]: 100000 });
    store.addTransaction(
      purchase({
        cardId: bank.id,
        amountMinor: 5000,
        reference: 'VERIFIED_BANK_REF',
        balanceTiming: 'AFTER_BASELINE',
      }),
    );
    await settle();
    const before = balance(bank.id);
    const candidate = await stage(evidence({ reference: 'VERIFIED_BANK_REF', amountMinor: 5000 }));
    await expect(
      review.approveBank(candidate, {
        purpose: 'PURCHASE',
        sourceId: bank.id,
        amountMinor: 5001,
        description: 'Edited',
        transactionDate: today,
        allowSeparate: true,
      }),
    ).rejects.toThrow('referenced bank purchase');
    expect(balance(bank.id)).toBe(before);
    expect(count('card_transactions')).toBe(1);
    expect(count('sms_reconciliation')).toBe(0);
  });
  it('enters second and third payments using searchable custom pickers and preserves real rows when changing type', async () => {
    const { store } = await boot();
    store.addCard(card);
    await settle();
    const date = indiaTodayIso(new Date(Date.now() + 86400000));
    const anchor = purchase({
      id: 'entry-anchor',
      cardId: card.id,
      amountMinor: 20000,
      transactionDate: date,
      merchant: 'Local Market',
    });
    await store.saveManualTransaction(anchor);
    const fixture = TestBed.createComponent(TransactionsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    page.openAdd();
    page.form.patchValue({
      type: 'ADJUSTMENT',
      cardId: 'source-debit',
      amount: '20',
      transactionDate: date,
      categoryId: 'other',
      merchant: 'Local Market',
    });
    await page.save();
    expect(page.form.controls.relatedTransactionId.hasError('required')).toBe(true);
    expect(count('card_transactions')).toBe(1);
    page.setRelatedTransaction(anchor.id);
    page.setManualPaymentMethod('UPI');
    page.setManualPaymentDetail('GPAY');
    page.form.controls.smsAdditionalComment.setValue('Remainder paid at the store');
    fixture.detectChanges();
    const picker = fixture.debugElement
      .queryAll(By.directive(AppSelectPicker))
      .map((element) => element.componentInstance as AppSelectPicker)
      .find((element) => element.label().includes('Related purchase'))!;
    expect(picker.searchable()).toBe(true);
    expect(fixture.nativeElement.querySelector('select')).toBeNull();
    await page.save();
    const second = store.transactions().find((entry) => entry.id !== anchor.id)!;
    expect(second).toMatchObject({
      type: 'ADJUSTMENT',
      adjustmentPurpose: 'SPLIT_PAYMENT',
      amountMinor: 2000,
      paymentMethod: 'UPI',
      paymentMethodDetail: 'GPAY',
      smsAdditionalComment: 'Remainder paid at the store',
    });
    const group = second.splitGroupId;
    page.openAdd();
    page.form.patchValue({
      type: 'ADJUSTMENT',
      cardId: 'source-cash',
      amount: '30',
      transactionDate: date,
      categoryId: 'other',
      merchant: 'Local Market',
    });
    page.setRelatedTransaction(second.id);
    expect(page.relatedPaymentEntries()).toHaveLength(2);
    await page.save();
    expect(store.paymentGroups()).toHaveLength(1);
    expect(store.paymentGroups()[0].id).toBe(group);
    expect(store.paymentGroups()[0].memberIds).toHaveLength(3);
    expect(calculateNetSpending(store.transactions())).toBe(25000);
    page.sourceFilter.set('source-debit');
    expect(page.logicalGroups()).toHaveLength(0);
    expect(page.visibleTransactions().map((entry) => entry.id)).toEqual([second.id]);
    page.edit(second);
    page.form.controls.type.setValue('PURCHASE');
    page.transactionTypeChanged('PURCHASE');
    page.form.controls.unlinkConfirmed.setValue(true);
    await page.save();
    expect(store.transactions().find((entry) => entry.id === second.id)).toMatchObject({
      type: 'PURCHASE',
      amountMinor: 2000,
      cardId: 'source-debit',
    });
    expect(
      store.transactions().find((entry) => entry.id === second.id)?.splitGroupId,
    ).toBeUndefined();
    expect(count('card_transactions')).toBe(3);
  });
  it('searches and records the explicitly selected bank source with tracking off and no deduction', async () => {
    const { store } = await boot();
    const checking = await store.addBankAccount({
      nickname: 'Everyday checking',
      institution: 'ICICI Bank',
      lastDigits: '45123',
    });
    const reserve = await store.addBankAccount({
      nickname: 'Reserve',
      institution: 'HDFC Bank',
      lastDigits: '00007',
    });
    expect(store.bankCashTracking().enabled).toBe(false);
    const fixture = TestBed.createComponent(TransactionsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance;
    page.openAdd();
    page.openPayFrom();
    fixture.detectChanges();
    const search = fixture.nativeElement.querySelector(
      '.pay-from-search input',
    ) as HTMLInputElement;
    search.value = 'HDFC Reserve 007';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    const options = fixture.nativeElement.querySelectorAll(
      '.pay-from-option',
    ) as NodeListOf<HTMLButtonElement>;
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('HDFC Bank');
    expect(options[0].textContent).toContain('Reserve');
    expect(options[0].textContent).toContain('•••007');
    options[0].click();
    expect(page.form.controls.cardId.value).toBe(reserve.id);
    page.form.patchValue({
      type: 'PURCHASE',
      amount: '10',
      transactionDate: today,
      categoryId: 'other',
      merchant: 'Synthetic bank purchase',
    });
    await page.save();
    const saved = store
      .transactions()
      .find((transaction) => transaction.merchant === 'Synthetic bank purchase');
    expect(saved).toMatchObject({ cardId: reserve.id, amountMinor: 1000 });
    expect(
      store.paymentSources().find((source) => source.id === reserve.id)?.balanceMinor,
    ).toBeUndefined();
    expect(
      store.paymentSources().find((source) => source.id === checking.id)?.balanceMinor,
    ).toBeUndefined();
    fixture.destroy();
  });
  it('saves unlimited independent payment members, edits classification and unlinks without repeating source effects', async () => {
    const { store, balance } = await boot();
    store.addCard(card);
    await settle();
    const bank = await store.addBankAccount({
      nickname: 'Daily bank',
      institution: 'ICICI',
      lastDigits: '417',
    });
    await store.addWallet({
      id: 'meal-split',
      kind: 'MEAL',
      institution: 'Pluxee',
      nickname: 'Meal',
      lastDigits: '8765',
      balanceMinor: 100000,
      noLimit: false,
      archived: false,
      autoLoad: false,
    });
    await store.enableBankCashTracking({ [bank.id]: 100000, 'source-cash': 100000 });
    const date = indiaTodayIso(new Date(Date.now() + 86400000));
    const first = purchase({
      id: 'first-payment',
      cardId: 'meal-split',
      amountMinor: 20000,
      transactionDate: date,
    });
    await store.saveManualTransaction(first);
    const second = purchase({
      id: 'second-payment',
      type: 'ADJUSTMENT',
      cardId: bank.id,
      amountMinor: 2000,
      transactionDate: date,
      reference: 'PRESERVE-UPI',
    });
    await store.saveManualTransaction(second, first.id);
    const group = store.transactions().find((entry) => entry.id === first.id)!.splitGroupId!;
    const third = purchase({
      id: 'third-payment',
      type: 'ADJUSTMENT',
      cardId: card.id,
      amountMinor: 3000,
      transactionDate: date,
    });
    await store.saveManualTransaction(third, second.id);
    await store.saveManualTransaction(
      purchase({
        id: 'fourth-payment',
        type: 'ADJUSTMENT',
        cardId: 'source-cash',
        amountMinor: 500,
        transactionDate: date,
      }),
      third.id,
    );
    await store.saveManualTransaction(third, second.id);
    expect(count('card_transactions')).toBe(4);
    expect(store.paymentGroups()).toHaveLength(1);
    expect(store.paymentGroups()[0].id).toBe(group);
    expect(store.paymentGroups()[0].memberIds).toHaveLength(4);
    expect(calculateNetSpending(store.transactions())).toBe(25500);
    expect([
      balance('meal-split'),
      balance(bank.id),
      balance('source-cash'),
      store.cardOutstanding(card.id),
    ]).toEqual([80000, 98000, 99500, 3000]);
    const beforeSources = structuredClone(store.paymentSources());
    await store.updatePaymentGroup(group, { title: 'Local Market', billTotalMinor: 21000 });
    await store.removePaymentMember(second.id);
    const savedThird = store.transactions().find((entry) => entry.id === third.id)!;
    await expect(store.saveManualTransaction({ ...savedThird, type: 'PURCHASE' })).rejects.toThrow(
      'Confirm removing',
    );
    await store.saveManualTransaction({ ...savedThird, type: 'PURCHASE' }, '', true);
    await store.removePaymentMember(group, true);
    expect(store.paymentGroups()).toHaveLength(0);
    expect(store.paymentSources()).toEqual(beforeSources);
    expect(calculateNetSpending(store.transactions())).toBe(25500);
    expect(store.transactions().find((entry) => entry.id === second.id)?.reference).toBe(
      'PRESERVE-UPI',
    );
    await store.saveManualTransaction(
      { ...store.transactions().find((entry) => entry.id === second.id)!, type: 'CREDIT' },
      '',
      true,
    );
    expect(balance(bank.id)).toBe(102000);
    await store.deleteRecordedTransaction(first.id);
    expect(balance('meal-split')).toBe(100000);
  });
  it('rolls back a failed division completely and does not clone SMS references, receipts or annotations onto new allocations', async () => {
    const { store, review } = await boot();
    store.addCard(card);
    await settle();
    const bank = await store.addBankAccount({
      nickname: 'Daily bank',
      institution: 'ICICI',
      lastDigits: '417',
    });
    await store.addWallet({
      id: 'division-meal',
      kind: 'MEAL',
      institution: 'Pluxee',
      nickname: 'Meal',
      balanceMinor: 100000,
      noLimit: false,
      archived: false,
      autoLoad: false,
    });
    await store.enableBankCashTracking({ [bank.id]: 100000, 'source-cash': 100000 });
    const date = indiaTodayIso(new Date(Date.now() + 86400000));
    const original = purchase({
      id: 'division-original',
      cardId: 'division-meal',
      amountMinor: 10000,
      transactionDate: date,
      reference: 'NATIVE-REFERENCE',
      origin: 'SMS',
      notes: 'Original SMS audit',
      smsAdditionalComment: 'Original comment',
      attachmentIds: ['private-original-receipt'],
    });
    await store.saveManualTransaction(original);
    const bound = await stage(
      evidence({
        id: '8'.repeat(64),
        kind: 'PLUXEE_PURCHASE',
        issuer: 'Pluxee',
        cardDigits: undefined,
        accountDigits: undefined,
        eventDate: date,
        amountMinor: 10000,
        reference: 'NATIVE-REFERENCE',
      }),
      'MATCHED_EXISTING',
    );
    await database.run(
      "UPDATE sms_candidates SET transaction_id=?,decision='AUTO_EXISTING: verified original payment' WHERE id=?",
      [original.id, bound.id],
    );
    await database.run(
      'INSERT INTO sms_reconciliation(id,candidate_id,target_id,decision,amount_minor,created_at) VALUES(?,?,?,?,?,?)',
      [
        'division-native-audit',
        bound.id,
        original.id,
        'AUTO_EXISTING: verified original payment',
        10000,
        'before',
      ],
    );
    const before = {
      entries: structuredClone(store.transactions()),
      sources: structuredClone(store.paymentSources()),
    };
    const parts = [
      { sourceId: 'division-meal', amountMinor: 2000 },
      { sourceId: card.id, amountMinor: 2000 },
      { sourceId: bank.id, amountMinor: 2000 },
      { sourceId: 'source-cash', amountMinor: 2000 },
      { sourceId: 'division-meal', amountMinor: 2000 },
    ];
    sql.exec(
      "CREATE TRIGGER fail_division BEFORE INSERT ON transaction_split_members BEGIN SELECT RAISE(ABORT,'Synthetic division failure'); END",
    );
    await expect(store.splitTransaction(original.id, parts)).rejects.toThrow(
      'Synthetic division failure',
    );
    expect(store.transactions()).toEqual(before.entries);
    expect(store.paymentSources()).toEqual(before.sources);
    expect(count('card_transactions')).toBe(1);
    expect(count('transaction_split_groups')).toBe(0);
    sql.exec('DROP TRIGGER fail_division');
    const entries = await store.splitTransaction(original.id, parts);
    expect(entries).toHaveLength(5);
    expect(entries[0].id).toBe(original.id);
    expect(entries[0].reference).toBe('NATIVE-REFERENCE');
    for (const entry of entries.slice(1))
      expect(entry).toMatchObject({ origin: 'MANUAL', attachmentIds: [] });
    for (const entry of entries.slice(1)) {
      expect(entry.reference).toBeUndefined();
      expect(entry.notes).toBeUndefined();
      expect(entry.smsAdditionalComment).toBeUndefined();
    }
    expect(calculateNetSpending(store.transactions())).toBe(10000);
    expect(store.paymentGroups()[0].kind).toBe('DIVISION');
    expect(count('card_transactions')).toBe(5);
    await review.reevaluatePending();
    expect(
      rows('SELECT state,transaction_id,decision FROM sms_candidates WHERE id=?', [bound.id])[0],
    ).toMatchObject({
      state: 'MATCHED_EXISTING',
      transaction_id: original.id,
      decision: expect.stringContaining('EXPLICIT_DIVISION:'),
    });
    expect(count('card_transactions')).toBe(5);
  });
  it('reclassifies a positive legacy adjustment without changing its original payment or reference', async () => {
    const { store, balance } = await boot();
    const bank = await store.addBankAccount({
      nickname: 'Daily bank',
      institution: 'ICICI',
      lastDigits: '417',
    });
    await store.enableBankCashTracking({ [bank.id]: 100000 });
    const date = indiaTodayIso(new Date(Date.now() + 86400000));
    const anchor = purchase({
      id: 'legacy-anchor',
      cardId: bank.id,
      amountMinor: 20000,
      transactionDate: date,
    });
    await store.saveManualTransaction(anchor);
    store.addTransaction(
      purchase({
        id: 'legacy-extra',
        type: 'ADJUSTMENT',
        adjustmentPurpose: 'LEGACY_MANUAL',
        cardId: bank.id,
        amountMinor: 2000,
        reference: 'ORIGINAL-LEGACY',
        transactionDate: date,
      }),
    );
    await settle();
    await store.refreshPaymentLedger();
    const legacy = store.transactions().find((entry) => entry.id === 'legacy-extra')!;
    const before = balance(bank.id);
    const effect = structuredClone(legacy.balanceEffect);
    await store.saveManualTransaction(legacy, anchor.id);
    expect(balance(bank.id)).toBe(before);
    expect(store.transactions().find((entry) => entry.id === legacy.id)).toMatchObject({
      id: legacy.id,
      cardId: bank.id,
      amountMinor: 2000,
      reference: 'ORIGINAL-LEGACY',
      balanceEffect: effect,
      adjustmentPurpose: 'SPLIT_PAYMENT',
    });
    expect(calculateNetSpending(store.transactions())).toBe(22000);
  });
  it('groups only continuous SMS payments after final approval, joins the third payment, and rejects a stale interrupted sequence atomically', async () => {
    const { store, review, balance } = await boot();
    store.addCard(card);
    await settle();
    const bank = await store.addBankAccount({
      nickname: 'Daily bank',
      institution: 'ICICI',
      lastDigits: '417',
    });
    await store.enableBankCashTracking({ [bank.id]: 100000 });
    await store.addWallet({
      id: 'sms-group-meal',
      kind: 'MEAL',
      institution: 'Pluxee',
      nickname: 'Meal',
      lastDigits: '8765',
      balanceMinor: 100000,
      noLimit: false,
      archived: false,
      autoLoad: false,
    });
    const date = indiaTodayIso(new Date(Date.now() + 86400000));
    const start = Date.parse(`${date}T06:30:00Z`);
    const item = (
      id: string,
      minutes: number,
      amountMinor: number,
      extra: Partial<SmsEvidence>,
    ) => {
      const stamp = new Date(start + minutes * 60000 + 330 * 60000).toISOString();
      return evidence({
        id: id.repeat(64),
        providerId: id,
        amountMinor,
        eventDate: date,
        eventAt: new Date(start + minutes * 60000).toISOString(),
        eventTime: stamp.slice(11, 19),
        eventTimeExplicit: true,
        receivedAt: start + (minutes + 1) * 60000,
        merchant: 'Local Market',
        reference: `SYNTH-SPLIT-${id}`,
        ...extra,
      });
    };
    const first = await stage(
      item('a', 0, 20000, {
        kind: 'PLUXEE_PURCHASE',
        issuer: 'Pluxee',
        cardDigits: '8765',
        accountDigits: undefined,
        direction: undefined,
        purposeHint: undefined,
      }),
    );
    await review.approve(first, 'sms-group-meal', 20000, 'Local Market');
    const second = await stage(
      item('b', 5, 2000, {
        kind: 'BANK_DEBIT',
        cardDigits: undefined,
        accountDigits: '417',
        issuer: 'ICICI',
      }),
    );
    const proposal = await review.splitSuggestion(second, bank.id);
    expect(proposal?.targetId).toBe(`sms-${first.id}`);
    expect(count('transaction_split_groups')).toBe(0);
    await review.approveBank(second, {
      purpose: 'PURCHASE',
      sourceId: bank.id,
      amountMinor: 2000,
      description: 'Local Market',
      transactionDate: date,
      splitTargetId: proposal!.targetId,
    });
    const group = store.paymentGroups()[0].id;
    expect(store.paymentGroups()[0].memberIds).toHaveLength(2);
    const third = await stage(
      item('c', 10, 3000, {
        kind: 'PURCHASE',
        issuer: 'ICICI',
        cardDigits: '4321',
        accountDigits: undefined,
        direction: undefined,
        purposeHint: undefined,
      }),
    );
    expect((await review.splitSuggestion(third, card.id))?.targetId).toBe(group);
    expect(store.paymentGroups()[0].memberIds).toHaveLength(2);
    await review.approve(third, card.id, 3000, 'Local Market', '', 'PENDING', false, '', 0, {
      splitTargetId: group,
    });
    await review.approve(third, card.id, 3000, 'Local Market', '', 'PENDING', false, '', 0, {
      splitTargetId: group,
    });
    expect(count('card_transactions')).toBe(3);
    expect(store.paymentGroups()[0].memberIds).toHaveLength(3);
    expect(calculateNetSpending(store.transactions())).toBe(25000);
    expect([balance('sms-group-meal'), balance(bank.id), store.cardOutstanding(card.id)]).toEqual([
      80000, 98000, 3000,
    ]);
    const thirdPayment = store.transactions().find((entry) => entry.id === `sms-${third.id}`)!;
    await store.saveManualTransaction({ ...thirdPayment, type: 'ADJUSTMENT' }, group);
    expect(
      rows('SELECT state,transaction_id,decision FROM sms_candidates WHERE id=?', [third.id])[0],
    ).toMatchObject({
      state: 'IMPORTED',
      transaction_id: thirdPayment.id,
      decision: expect.stringContaining('EXPLICIT_TYPE_CHANGE'),
    });
    const confirmation = await stage({
      ...third.item!,
      id: 'f'.repeat(64),
      providerId: 'other-confirmation',
      receivedAt: start + 12 * 60000,
    });
    await review.approve(confirmation, card.id, 3000, 'Local Market', thirdPayment.id);
    expect(count('card_transactions')).toBe(3);
    expect(store.cardOutstanding(card.id)).toBe(3000);
    expect(store.paymentGroups()[0].memberIds).toHaveLength(3);
    await stage(
      item('d', 13, 100000, {
        kind: 'PURCHASE',
        cardDigits: '9999',
        accountDigits: undefined,
        direction: undefined,
        purposeHint: undefined,
        merchant: 'Petrol Station',
      }),
    );
    const later = await stage(
      item('e', 20, 4000, {
        kind: 'BANK_DEBIT',
        accountDigits: '417',
        cardDigits: undefined,
        issuer: 'ICICI',
      }),
    );
    expect(await review.splitSuggestion(later, bank.id)).toBeNull();
    await expect(
      review.approveBank(later, {
        purpose: 'PURCHASE',
        sourceId: bank.id,
        amountMinor: 4000,
        description: 'Local Market',
        transactionDate: date,
        splitTargetId: group,
      }),
    ).rejects.toThrow('continuity');
    expect(count('card_transactions')).toBe(3);
    expect(balance(bank.id)).toBe(98000);
    await review.approveBank(later, {
      purpose: 'PURCHASE',
      sourceId: bank.id,
      amountMinor: 4000,
      description: 'Local Market',
      transactionDate: date,
    });
    const after = balance(bank.id);
    await store.combinePayments([`sms-${later.id}`], group);
    expect(balance(bank.id)).toBe(after);
    expect(store.paymentGroups()[0].memberIds).toHaveLength(4);
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
        reference: '735182094617',
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
    const balancesBeforeGrouping = structuredClone(store.paymentSources());
    const restoredGroupId = await store.combinePayments(
      [cardEntry.id, bankEntry.id],
      cardEntry.id,
      { title: 'Synthetic combined bill', billTotalMinor: 20000 },
    );
    expect(store.paymentSources()).toEqual(balancesBeforeGrouping);
    const before = {
      groups: structuredClone(store.paymentGroups()),
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
      expect(restarted.paymentGroups()).toEqual(before.groups);
      expect(restarted.paymentGroups()[0].id).toBe(restoredGroupId);
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
    expect(await store.deleteCategory('other')).toBe(false);
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
