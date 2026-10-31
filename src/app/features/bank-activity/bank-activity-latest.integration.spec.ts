vi.hoisted(() => vi.resetModules());

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { DatabaseSession, SqliteDatabase } from '../../core/data/sqlite-database';
import { DATABASE_MIGRATIONS } from '../../core/data/migrations';
import { RECONCILE_BANK_ACTIVITY_LATEST } from '../../core/data/bank-activity-latest';
import { CardNestStore } from '../../core/services/card-nest-store';
import { PaymentSource } from '../../core/models/domain';
import { fingerprintCompleteBankAccount } from '../../core/services/bank-account-identifier';
import { BankActivityService } from './bank-activity.service';
import { BankAccountSyncService } from './bank-account-sync.service';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

describe('Latest activity and identity reconciliation with real SQLite', () => {
  let sql: InstanceType<typeof DatabaseSync>;
  let activity: BankActivityService;
  let sync: BankAccountSyncService;
  const sources = signal<readonly PaymentSource[]>([]);
  const testFingerprintKey = new Uint8Array(32).fill(11);
  const finance = () =>
    [
      'card_transactions',
      'credit_cards',
      'source_transfers',
      'source_balance_adjustments',
      'transaction_split_groups',
      'sms_candidates',
      'statements',
    ].map((table) => sql.prepare('SELECT * FROM ' + table).all());
  const query: DatabaseSession['query'] = async <T extends Record<string, unknown>>(
    statement: string,
    values: readonly unknown[] = [],
  ) => sql.prepare(statement).all(...(values as import('node:sqlite').SQLInputValue[])) as T[];
  const run: DatabaseSession['run'] = async (statement, values = []) =>
    Number(
      sql.prepare(statement).run(...(values as import('node:sqlite').SQLInputValue[])).changes,
    );
  const enable = () =>
    sql
      .prepare(
        "INSERT INTO app_preferences VALUES('bank_cash_tracking',?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value",
      )
      .run(JSON.stringify({ enabled: true }));
  const evidence = (
    fingerprint: string,
    activityDate: string,
    direction: 'DEBIT' | 'CREDIT' = 'DEBIT',
  ) => ({
    fingerprint,
    activityDate,
    direction,
    kind: direction === 'DEBIT' ? 'BANK_DEBIT' : 'BANK_CREDIT',
    purposeHint: direction === 'DEBIT' ? 'PURCHASE' : 'INCOMING',
    issuer: 'ICICI',
    accountDigits: '00123',
    merchant: 'Fiction person',
    parserVersion: 3,
  });
  beforeEach(() => {
    sql = new DatabaseSync(':memory:');
    sql.exec('PRAGMA foreign_keys=ON');
    for (const migration of DATABASE_MIGRATIONS)
      for (const statement of migration.statements) sql.exec(statement);
    sources.set([]);
    let tail: Promise<unknown> = Promise.resolve();
    const database = {
      ready: () => true,
      query,
      run,
      atomic: <T>(work: (tx: DatabaseSession) => Promise<T>): Promise<T> => {
        const next = tail.then(async () => {
          sql.exec('BEGIN');
          try {
            const value = await work({ query, run });
            sql.exec('COMMIT');
            return value;
          } catch (error: unknown) {
            sql.exec('ROLLBACK');
            throw error;
          }
        });
        tail = next.catch(() => undefined);
        return next;
      },
    };
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    TestBed.configureTestingModule({
      providers: [
        { provide: SqliteDatabase, useValue: database },
        {
          provide: CardNestStore,
          useValue: {
            paymentSources: sources,
            fingerprintBankAccount: (value: string) =>
              fingerprintCompleteBankAccount(value, testFingerprintKey),
          },
        },
      ],
    });
    activity = TestBed.inject(BankActivityService);
    sync = TestBed.inject(BankAccountSyncService);
  });
  afterEach(() => {
    sql.close();
    vi.restoreAllMocks();
  });
  it('retains a completed discovery cursor, reads only new alerts and resumes after interruption', async () => {
    const stage = async (id: string) =>
      run(
        'INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,payload,updated_at) VALUES(?,?,?,?,?,?,?)',
        [
          id,
          id,
          '2026-10-25',
          'BANK_DEBIT',
          'PENDING',
          JSON.stringify({
            ...evidence(id, '2026-10-25'),
            id,
            eventDate: '2026-10-25',
            dateFallback: false,
          }),
          '2026-10-25',
        ],
      );
    await stage('scan-a');
    await stage('scan-b');
    const before = finance();
    expect(await activity.discoverSavedEvidence()).toBe(2);
    expect(await activity.discoverSavedEvidence()).toBe(0);
    expect(finance()).toEqual(before);
    await stage('scan-c');
    vi.spyOn(activity, 'ingestAndroidSms').mockRejectedValueOnce(new Error('Interrupted scan'));
    await expect(activity.discoverSavedEvidence()).rejects.toThrow('Interrupted scan');
    expect(await activity.discoverSavedEvidence()).toBe(1);
    expect(await activity.discoverSavedEvidence()).toBe(0);
    expect(activity.candidates()).toHaveLength(3);
  });
  it('serializes overlapping reloads and keeps a newer committed source publication', async () => {
    const own = await activity.saveProfile({
      bankName: 'ICICI',
      accountSuffix: '123',
      owner: 'OWN',
    });
    enable();
    const reconcile = sync.reconcile.bind(sync);
    let release!: () => void;
    let active = 0;
    let peak = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstReconcile = true;
    vi.spyOn(sync, 'reconcile').mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      const result = await reconcile();
      if (firstReconcile) {
        firstReconcile = false;
        await gate;
      }
      active--;
      return result;
    });
    const first = activity.reload();
    // Wait for the real coordinator's commit, then model a later source-write publication.
    const database = TestBed.inject(SqliteDatabase);
    await database.atomic(async (tx) => {
      const [row] = await tx.query<{ encrypted_value: string }>(
        "SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'",
      );
      const saved = JSON.parse(row.encrypted_value) as PaymentSource[];
      const edited = saved.map((source) => ({ ...source, nickname: 'Later committed nickname' }));
      await tx.run("UPDATE app_preferences SET encrypted_value=? WHERE key='payment_sources'", [
        JSON.stringify(edited),
      ]);
      sources.set(edited);
    });
    const second = activity.reload();
    release();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
    expect(sources()[0].nickname).toBe('Later committed nickname');
    expect(activity.profiles().find((profile) => profile.id === own.id)?.paymentSourceId).toBe(
      sources()[0].id,
    );
    expect(activity.profiles()).toHaveLength(1);
    expect(activity.events()).toHaveLength(0);
  });

  it('replaces only the selected direction, suppresses stale/replayed SMS and preserves finance', async () => {
    const profile = await activity.saveProfile({
      bankName: 'ICICI',
      accountSuffix: '123',
      owner: 'OWN',
    });
    const before = finance();
    const debit = await activity.saveManualEvent({
      profileId: profile.id,
      activityDate: '2026-10-25',
      direction: 'DEBIT',
    });
    await activity.saveManualEvent({
      profileId: profile.id,
      activityDate: '2026-10-22',
      direction: 'CREDIT',
    });
    await expect(
      activity.saveManualEvent({
        profileId: profile.id,
        activityDate: '2026-10-20',
        direction: 'DEBIT',
      }),
    ).rejects.toThrow('2026-10-25');
    await activity.ingestAndroidSms(evidence('stale', '2026-10-20'));
    await activity.ingestAndroidSms(evidence('same', '2026-10-25'));
    expect(activity.candidates()).toHaveLength(0);
    expect(activity.events().find((row) => row.direction === 'DEBIT')?.id).toBe(debit.id);
    await activity.ingestAndroidSms(evidence('new-credit', '2026-10-26', 'CREDIT'));
    expect(activity.candidates()).toHaveLength(1);
    expect(activity.events().find((row) => row.direction === 'CREDIT')?.activityDate).toBe(
      '2026-10-22',
    );
    await Promise.all([
      activity.approveCandidate('new-credit', profile.id),
      activity.approveCandidate('new-credit', profile.id),
    ]);
    expect(activity.events()).toHaveLength(2);
    expect(activity.summaryFor(profile.id, '2026-10-27').lastActivityDate).toBe('2026-10-26');
    await activity.reload();
    await activity.ingestAndroidSms(evidence('stale', '2026-10-20'));
    expect(activity.candidates()).toHaveLength(0);
    await activity.deleteEvent(activity.events().find((row) => row.direction === 'CREDIT')!.id);
    await activity.ingestAndroidSms(evidence('new-credit', '2026-10-26', 'CREDIT'));
    expect(activity.events()).toHaveLength(1);
    expect(activity.candidates()).toHaveLength(0);
    expect(finance()).toEqual(before);
  });

  it('allows an explicit date correction and rolls back both replacement and dismissal on failure', async () => {
    const profile = await activity.saveProfile({
      bankName: 'ICICI',
      accountSuffix: '123',
      owner: 'OWN',
    });
    const first = await activity.saveManualEvent({
      profileId: profile.id,
      activityDate: '2026-10-25',
      direction: 'DEBIT',
    });
    await activity.saveManualEvent({
      id: first.id,
      profileId: profile.id,
      activityDate: '2026-10-24',
      direction: 'DEBIT',
    });
    await activity.ingestAndroidSms(evidence('new', '2026-10-26'));
    sql.exec(
      "CREATE TRIGGER fail_confirmation BEFORE UPDATE ON bank_activity_candidates BEGIN SELECT RAISE(ABORT,'rollback'); END",
    );
    await expect(activity.approveCandidate('new', profile.id)).rejects.toThrow('rollback');
    expect(
      (await query<{ activity_date: string }>('SELECT activity_date FROM bank_activity_events'))[0]
        .activity_date,
    ).toBe('2026-10-24');
    expect(activity.candidates()).toHaveLength(1);
    await expect(
      activity.saveManualEvent({
        profileId: profile.id,
        activityDate: '2026-02-30',
        direction: 'DEBIT',
      }),
    ).rejects.toThrow('valid activity date');
    await expect(
      activity.saveManualEvent({
        profileId: profile.id,
        activityDate: '2099-01-01',
        direction: 'DEBIT',
      }),
    ).rejects.toThrow('valid activity date');
  });

  it('compacts legacy history idempotently, preserves deterministic ties and all fingerprints', async () => {
    const profile = await activity.saveProfile({
      bankName: 'ICICI',
      accountSuffix: '123',
      owner: 'OWN',
    });
    for (const [id, date, direction] of [
      ['a', '2026-10-25', 'DEBIT'],
      ['b', '2026-10-25', 'DEBIT'],
      ['c', '2026-10-20', 'DEBIT'],
      ['d', '2026-10-22', 'CREDIT'],
      ['e', '2026-02-30', 'CREDIT'],
    ] as const) {
      const payload = {
        id,
        profileId: profile.id,
        activityDate: date,
        direction,
        origin: 'ANDROID_SMS',
        verification: 'USER_CONFIRMED',
        fingerprint: id,
        createdAt: date,
        updatedAt: date,
      };
      await run('INSERT INTO bank_activity_events VALUES(?,?,?,?,?,?,?,?,?,?)', [
        id,
        profile.id,
        date,
        direction,
        'ANDROID_SMS',
        'USER_CONFIRMED',
        id,
        JSON.stringify(payload),
        date,
        date,
      ]);
    }
    for (const [id, payload] of [
      ['malformed', '{'],
      ['missing-fields', '{}'],
    ] as const)
      await run('INSERT INTO bank_activity_events VALUES(?,?,?,?,?,?,?,?,?,?)', [
        id,
        profile.id,
        '2026-10-26',
        'DEBIT',
        'ANDROID_SMS',
        'USER_CONFIRMED',
        id,
        payload,
        '2026-10-26',
        '2026-10-26',
      ]);
    const before = finance();
    for (let pass = 0; pass < 2; pass++)
      for (const statement of RECONCILE_BANK_ACTIVITY_LATEST) sql.exec(statement);
    await activity.reload();
    expect(
      activity
        .events()
        .map((row) => row.id)
        .sort(),
    ).toEqual(['a', 'd']);
    expect(await query('SELECT fingerprint FROM bank_activity_candidates')).toHaveLength(7);
    expect(activity.candidates()).toHaveLength(0);
    expect(finance()).toEqual(before);
  });

  it('synchronizes OWN identities in both directions once, with leading zeros and no balances or activity', async () => {
    const own = await activity.saveProfile({
      bankName: 'ICICI',
      accountSuffix: '007',
      nickname: 'Custom nickname',
      owner: 'OWN',
    });
    await activity.saveProfile({
      bankName: 'HDFC',
      accountSuffix: '999',
      owner: 'OTHERS',
      holderName: 'Family',
    });
    expect(
      await query("SELECT * FROM app_preferences WHERE key='bank_cash_tracking'"),
    ).toHaveLength(0);
    expect(sources()).toHaveLength(1);
    const createdWhileTrackingOff = sources()[0];
    expect(createdWhileTrackingOff).toMatchObject({
      institution: 'ICICI Bank',
      lastDigits: '007',
      nickname: 'Custom nickname',
    });
    expect(createdWhileTrackingOff.balanceMinor).toBeUndefined();
    expect(createdWhileTrackingOff.balanceCutoverAt).toBeUndefined();
    expect(activity.profiles().find((row) => row.id === own.id)?.paymentSourceId).toBe(
      createdWhileTrackingOff.id,
    );
    expect(await sync.reconcile()).toBeNull();
    enable();
    await activity.reload();
    const created = sources()[0];
    expect(created).toMatchObject({
      institution: 'ICICI Bank',
      lastDigits: '007',
      nickname: 'Custom nickname',
    });
    expect(created.balanceMinor).toBeUndefined();
    expect(activity.profiles().find((row) => row.id === own.id)?.paymentSourceId).toBe(created.id);
    const existing: PaymentSource = {
      id: 'salary',
      kind: 'DEBIT',
      institution: 'HDFC',
      lastDigits: '00567',
      nickname: 'Salary',
      archived: false,
      noLimit: true,
      autoLoad: false,
      balanceMinor: 456700,
    };
    await run("UPDATE app_preferences SET encrypted_value=? WHERE key='payment_sources'", [
      JSON.stringify([...sources(), existing]),
    ]);
    await activity.reload();
    const linked = activity.profiles().find((row) => row.paymentSourceId === existing.id)!;
    expect(linked).toMatchObject({ owner: 'OWN', accountSuffix: '567', nickname: 'Salary' });
    const snapshot = await query('SELECT * FROM app_preferences');
    const profiles = await query('SELECT * FROM bank_activity_profiles');
    for (let pass = 0; pass < 3; pass++) expect(await sync.reconcile()).toBeNull();
    expect(await query('SELECT * FROM app_preferences')).toEqual(snapshot);
    expect(await query('SELECT * FROM bank_activity_profiles')).toEqual(profiles);
    expect(activity.events()).toHaveLength(0);
    expect(
      JSON.parse(
        String(
          (
            await query<{ encrypted_value: string }>(
              "SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'",
            )
          )[0].encrypted_value,
        ),
      ).find((row: PaymentSource) => row.id === 'salary').balanceMinor,
    ).toBe(456700);
  });

  it('keeps ambiguous and family identities unlinked, preserves archives and rolls back creation/linking', async () => {
    const family = await activity.saveProfile({
      bankName: 'ICICI',
      accountSuffix: '123',
      owner: 'OTHERS',
      holderName: 'Family',
    });
    const ownProfile = {
      id: 'rollback-own-profile',
      bankName: 'HDFC',
      accountSuffix: '007',
      owner: 'OWN',
      archived: false,
      createdAt: 'before',
      updatedAt: 'before',
    };
    await run(
      'INSERT INTO bank_activity_profiles(id,payment_source_id,bank_name,archived,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      [
        ownProfile.id,
        null,
        ownProfile.bankName,
        0,
        JSON.stringify(ownProfile),
        ownProfile.createdAt,
        ownProfile.updatedAt,
      ],
    );
    enable();
    sql.exec(
      "CREATE TRIGGER fail_link BEFORE UPDATE ON bank_activity_profiles BEGIN SELECT RAISE(ABORT,'link rollback'); END",
    );
    await expect(sync.reconcile()).rejects.toThrow('link rollback');
    expect(await query("SELECT * FROM app_preferences WHERE key='payment_sources'")).toHaveLength(
      0,
    );
    sql.exec('DROP TRIGGER fail_link');
    await activity.reload();
    expect(sources()).toHaveLength(1);
    await expect(
      activity.saveProfile({
        id: family.id,
        bankName: 'ICICI',
        accountSuffix: '123',
        owner: 'OWN',
      }),
    ).rejects.toThrow('Confirm');
    const source: PaymentSource = {
      id: 'family-like',
      kind: 'DEBIT',
      institution: 'ICICI',
      lastDigits: '00123',
      nickname: 'Unresolved',
      archived: false,
      noLimit: true,
      autoLoad: false,
    };
    await run("UPDATE app_preferences SET encrypted_value=? WHERE key='payment_sources'", [
      JSON.stringify([...sources(), source]),
    ]);
    await sync.reconcile();
    expect(sync.conflicts().length).toBeGreaterThan(0);
    expect(
      await query("SELECT * FROM bank_activity_profiles WHERE payment_source_id='family-like'"),
    ).toHaveLength(0);
    const own = activity.profiles().find((row) => row.owner === 'OWN')!;
    await activity.setArchived(own.id, true);
    await sync.reconcile();
    expect(activity.profiles().find((row) => row.id === own.id)?.archived).toBe(true);
    expect(sources()).toHaveLength(1);
  });
  it('reuses an existing source without changing custom metadata and leaves duplicate identities for explicit selection', async () => {
    const source: PaymentSource = {
      id: 'existing',
      kind: 'DEBIT',
      institution: 'ICICI Bank',
      nickname: 'Keep this nickname',
      lastDigits: '00123',
      balanceMinor: 765400,
      archived: false,
      noLimit: true,
      autoLoad: false,
    };
    await run("INSERT INTO app_preferences VALUES('payment_sources',?)", [
      JSON.stringify([source]),
    ]);
    sources.set([source]);
    enable();
    const unresolvedOwn = await activity.saveProfile({
      bankName: 'ICICI',
      accountSuffix: '123',
      nickname: 'Different monitor nickname',
      owner: 'OWN',
    });
    expect(unresolvedOwn.paymentSourceId).toBeUndefined();
    expect(sync.conflicts().join(' ')).toContain('identity is not proven');
    expect(
      JSON.parse(
        (
          await query<{ encrypted_value: string }>(
            "SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'",
          )
        )[0].encrypted_value,
      ),
    ).toEqual([{ ...source, isPrimaryBank: true }]);
    const own = await activity.saveProfile({
      ...unresolvedOwn,
      paymentSourceId: source.id,
      bankName: 'ICICI',
      owner: 'OWN',
    });
    expect(own.paymentSourceId).toBe(source.id);
    const second = { ...source, id: 'ambiguous-2', institution: 'HDFC', lastDigits: '00567' };
    const third = { ...second, id: 'ambiguous-3', nickname: 'Another account' };
    await run("UPDATE app_preferences SET encrypted_value=? WHERE key='payment_sources'", [
      JSON.stringify([source, second, third]),
    ]);
    sources.set([source, second, third]);
    await activity.reload();
    expect(activity.profiles()).toHaveLength(1);
    const unresolved = await activity.saveProfile({
      bankName: 'HDFC Bank',
      accountSuffix: '567',
      owner: 'OWN',
    });
    expect(unresolved.paymentSourceId).toBeUndefined();
    expect(sync.conflicts().length).toBeGreaterThan(0);
    const resolved = await activity.saveProfile({
      id: unresolved.id,
      paymentSourceId: second.id,
      bankName: 'HDFC',
      owner: 'OWN',
    });
    expect(resolved.paymentSourceId).toBe(second.id);
    await run("UPDATE app_preferences SET encrypted_value=? WHERE key='bank_cash_tracking'", [
      JSON.stringify({ enabled: false }),
    ]);
    const snapshot = await query('SELECT * FROM bank_activity_profiles');
    await sync.reconcile();
    expect(await query('SELECT * FROM bank_activity_profiles')).toEqual(snapshot);
    expect(activity.events()).toHaveLength(0);
  });

  describe('identity safety', () => {
    const storedSources = async () =>
      JSON.parse(
        (
          await query<{ encrypted_value: string }>(
            "SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'",
          )
        )[0]?.encrypted_value ?? '[]',
      ) as PaymentSource[];
    const legacy = (id: string, changes: Partial<PaymentSource> = {}): PaymentSource => ({
      id,
      kind: 'DEBIT',
      institution: 'ICICI Bank',
      nickname: id,
      lastDigits: '00123',
      balanceMinor: 50000,
      archived: false,
      noLimit: true,
      autoLoad: false,
      ...changes,
    });
    const seed = async (rows: PaymentSource[]) => {
      await run(
        "INSERT INTO app_preferences VALUES('payment_sources',?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value",
        [JSON.stringify(rows)],
      );
      sources.set(rows);
    };

    it('separates same-bank, same-suffix accounts only by distinct complete numbers and rejects exact or alias duplicates', async () => {
      const first = await activity.saveProfile({
        bankName: 'ICICI',
        accountIdentifier: '1234 5678 9123',
        owner: 'OWN',
      });
      const second = await activity.saveProfile({
        bankName: 'ICICI',
        accountIdentifier: '987654321123',
        owner: 'OWN',
      });
      expect(first.accountFingerprint).toMatch(/^hmac-sha256-v1:[0-9a-f]{64}$/);
      expect(second.accountFingerprint).not.toBe(first.accountFingerprint);
      await expect(
        activity.saveProfile({
          bankName: 'ICICI Bank',
          accountIdentifier: '123456789123',
          owner: 'OWN',
        }),
      ).rejects.toThrow('already exists');
      const otherBank = await activity.saveProfile({
        bankName: 'HDFC',
        accountIdentifier: '123456789123',
        owner: 'OWN',
      });
      expect(otherBank.accountSuffix).toBe('123');
      const saved = await storedSources();
      expect(saved).toHaveLength(3);
      expect(new Set(saved.map((row) => row.id)).size).toBe(3);
      const raw = JSON.stringify([
        saved,
        await query('SELECT payload FROM bank_activity_profiles'),
      ]);
      expect(raw).not.toContain('123456789123');
      expect(raw).not.toContain('987654321123');
      expect(saved.filter((row) => row.isPrimaryBank)).toHaveLength(1);
    });

    it('preserves leading zeros through masking, suffixes and fingerprints', async () => {
      const profile = await activity.saveProfile({
        bankName: 'SBI',
        accountIdentifier: '000000000007',
        owner: 'OWN',
      });
      expect(profile.accountSuffix).toBe('007');
      expect((await storedSources())[0]).toMatchObject({
        lastDigits: '007',
        institution: 'State Bank of India',
      });
      await expect(
        activity.saveProfile({
          bankName: 'State Bank of India',
          accountIdentifier: '000000000007',
          owner: 'OWN',
        }),
      ).rejects.toThrow('already exists');
      const distinct = await activity.saveProfile({
        bankName: 'SBI',
        accountIdentifier: '000000001007',
        owner: 'OWN',
      });
      expect(distinct.accountSuffix).toBe('007');
    });

    it('keeps two legacy same-suffix sources unchanged until the user links one by stable ID', async () => {
      const a = legacy('legacy-a');
      const b = legacy('legacy-b', { nickname: 'Second' });
      await seed([a, b]);
      const before = finance();
      const unresolved = await activity.saveProfile({
        bankName: 'ICICI',
        accountSuffix: '123',
        owner: 'OWN',
      });
      expect(unresolved.paymentSourceId).toBeUndefined();
      expect(sync.conflicts().join(' ')).toContain('needs identification');
      expect(await storedSources()).toEqual([
        { ...a, isPrimaryBank: true },
        { ...b, isPrimaryBank: false },
      ]);
      const linked = await activity.saveProfile({
        ...unresolved,
        paymentSourceId: b.id,
        owner: 'OWN',
      });
      expect(linked.paymentSourceId).toBe(b.id);
      const relinked = await activity.saveProfile({ ...linked, nickname: 'Edited monitor' });
      expect(relinked.paymentSourceId).toBe(b.id);
      expect(await storedSources()).toEqual([
        { ...a, isPrimaryBank: true },
        { ...b, isPrimaryBank: false },
      ]);
      expect(finance()).toEqual(before);
    });

    it('synchronizes edited identifiers, never retains a stale fingerprint, and updates or clears IFSC atomically', async () => {
      const fingerprinted = await activity.saveProfile({
        bankName: 'ICICI',
        accountIdentifier: '123456789123',
        ifscCode: 'icic0001234',
        owner: 'OWN',
      });
      const [source] = await storedSources();
      expect(source).toMatchObject({
        ifscCode: 'ICIC0001234',
        accountFingerprint: fingerprinted.accountFingerprint,
      });
      const before = finance();
      await expect(
        activity.updateOwnMoneySourceIdentity({
          sourceId: source.id,
          nickname: 'Edited',
          institution: 'ICICI',
          accountIdentifier: 'xxxx456',
          ifscCode: 'BAD',
        }),
      ).rejects.toThrow('IFSC');
      expect(await storedSources()).toEqual([{ ...source, isPrimaryBank: true }]);
      const masked = await activity.updateOwnMoneySourceIdentity({
        sourceId: source.id,
        nickname: 'Edited',
        institution: 'ICICI',
        accountIdentifier: 'xxxx456',
        ifscCode: '',
      });
      expect(masked).toMatchObject({ id: source.id, lastDigits: '456', accountMask: '••••456' });
      expect(masked.accountFingerprint).toBeUndefined();
      expect(masked.ifscCode).toBeUndefined();
      const full = await activity.updateOwnMoneySourceIdentity({
        sourceId: source.id,
        nickname: 'Edited',
        institution: 'ICICI',
        accountIdentifier: '555555555456',
        ifscCode: 'ICIC0009999',
      });
      expect(full.accountFingerprint).toMatch(/^hmac-sha256-v1:[0-9a-f]{64}$/);
      expect(full.accountFingerprint).not.toBe(fingerprinted.accountFingerprint);
      const profile = activity.profiles().find((row) => row.paymentSourceId === source.id)!;
      expect(profile).toMatchObject({
        accountSuffix: '456',
        accountFingerprint: full.accountFingerprint,
        ifscCode: 'ICIC0009999',
      });
      expect(JSON.stringify(await storedSources())).not.toContain('555555555456');
      expect(finance()).toEqual(before);
    });

    it('changes OWN to OTHERS and back only with an explicit choice, without moving balances', async () => {
      const source = legacy('own-source');
      await seed([source]);
      const own = await activity.saveProfile({
        bankName: 'ICICI',
        paymentSourceId: source.id,
        owner: 'OWN',
      });
      const before = finance();
      await expect(
        activity.saveProfile({ ...own, owner: 'OTHERS', holderName: 'Family' }),
      ).rejects.toThrow('Only an account');
      const family = await activity.saveProfile({
        ...own,
        paymentSourceId: undefined,
        owner: 'OTHERS',
        holderName: 'Family',
      });
      expect(family.paymentSourceId).toBeUndefined();
      await expect(
        activity.saveProfile({ ...family, owner: 'OWN', paymentSourceId: source.id }),
      ).rejects.toThrow('Confirm');
      const restored = await activity.saveProfile({
        ...family,
        owner: 'OWN',
        paymentSourceId: source.id,
        confirmOwnershipSync: true,
      });
      expect(restored).toMatchObject({ id: own.id, paymentSourceId: source.id });
      expect(await storedSources()).toEqual([{ ...source, isPrimaryBank: true }]);
      expect(finance()).toEqual(before);
    });

    it('rolls back a failed profile save and reconciles repeatedly without duplicate sources', async () => {
      sql.exec(
        "CREATE TRIGGER fail_profile BEFORE INSERT ON bank_activity_profiles BEGIN SELECT RAISE(ABORT,'profile failure'); END",
      );
      await expect(
        activity.saveProfile({
          bankName: 'ICICI',
          accountIdentifier: '123456789123',
          owner: 'OWN',
        }),
      ).rejects.toThrow('profile failure');
      expect(await query('SELECT * FROM bank_activity_profiles')).toHaveLength(0);
      expect(await storedSources()).toHaveLength(0);
      sql.exec('DROP TRIGGER fail_profile');
      await activity.saveProfile({
        bankName: 'ICICI',
        accountIdentifier: '123456789123',
        owner: 'OWN',
      });
      for (let pass = 0; pass < 3; pass++) await sync.reconcile();
      expect(await storedSources()).toHaveLength(1);
      expect(await query('SELECT * FROM bank_activity_profiles')).toHaveLength(1);
    });
  });
});
