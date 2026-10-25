import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { SqliteDatabase, DatabaseSession } from '../../core/data/sqlite-database';
import { CardNestStore } from '../../core/services/card-nest-store';
import { AndroidBankActivityEvidence, BankActivityService } from './bank-activity.service';
import { BankActivityEvent, BankActivityProfile } from './bank-activity-model';

describe('BankActivityService Android SMS matching', () => {
  let service: BankActivityService;
  let sources: {
    id: string;
    kind: string;
    institution: string;
    lastDigits: string;
    balanceMinor: number;
  }[];
  let profiles: Map<string, BankActivityProfile>;
  let events: Map<string, BankActivityEvent>;
  let candidates: Map<string, string>;
  let statements: string[];

  const queryRows = async (statement: string, values: readonly unknown[] = []) => {
    if (statement.includes('FROM bank_activity_profiles WHERE id=?')) {
      const profile = profiles.get(String(values[0]));
      return profile
        ? [{ payload: JSON.stringify(profile), archived: profile.archived ? 1 : 0 }]
        : [];
    }
    if (statement.includes('FROM bank_activity_events WHERE fingerprint=?')) {
      const event = [...events.values()].find((item) => item.fingerprint === values[0]);
      return event ? [{ id: event.id }] : [];
    }
    if (statement.includes('FROM bank_activity_candidates WHERE fingerprint=?')) {
      const payload = candidates.get(String(values[0]));
      return payload ? [{ payload }] : [];
    }
    if (statement.includes('FROM bank_activity_profiles'))
      return [...profiles.values()].map((profile) => ({ payload: JSON.stringify(profile) }));
    if (statement.includes('FROM bank_activity_events'))
      return [...events.values()].map((event) => ({ payload: JSON.stringify(event) }));
    if (statement.includes('FROM bank_activity_candidates'))
      return [...candidates.values()].map((payload) => ({ payload }));
    return [];
  };

  const runStatement = async (statement: string, values: readonly unknown[] = []) => {
    statements.push(statement);
    if (statement.startsWith('INSERT INTO bank_activity_profiles')) {
      const profile = JSON.parse(String(values[4])) as BankActivityProfile;
      profiles.set(profile.id, profile);
      return 1;
    }
    if (statement.startsWith('INSERT INTO bank_activity_events')) {
      const event = JSON.parse(String(values[7])) as BankActivityEvent;
      if (
        event.fingerprint &&
        [...events.values()].some((item) => item.fingerprint === event.fingerprint)
      )
        throw new Error('UNIQUE constraint failed: bank_activity_events.fingerprint');
      events.set(event.id, event);
      return 1;
    }
    if (statement.startsWith('INSERT OR IGNORE INTO bank_activity_candidates')) {
      const fingerprint = String(values[0]);
      if (candidates.has(fingerprint)) return 0;
      candidates.set(fingerprint, String(values[1]));
      return 1;
    }
    if (statement.startsWith('UPDATE bank_activity_candidates SET payload=?')) {
      candidates.set(String(values[1]), String(values[0]));
      return 1;
    }
    if (statement.startsWith('DELETE FROM bank_activity_candidates')) {
      candidates.delete(String(values[0]));
      return 1;
    }
    return 1;
  };
  const querySession = async <T extends Record<string, unknown>>(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<readonly T[]> => (await queryRows(statement, values)) as unknown as readonly T[];

  const database = {
    ready: () => true,
    query: (statement: string, values: readonly unknown[] = []) => queryRows(statement, values),
    run: (statement: string, values: readonly unknown[] = []) => runStatement(statement, values),
    atomic: <T>(work: (tx: DatabaseSession) => Promise<T>) =>
      work({ query: querySession, run: runStatement }),
  };

  const makeEvidence = (
    fingerprint: string,
    changes: Partial<AndroidBankActivityEvidence> = {},
  ): AndroidBankActivityEvidence => ({
    fingerprint,
    activityDate: '2026-10-26',
    kind: 'BANK_DEBIT',
    direction: 'DEBIT',
    purposeHint: 'PURCHASE',
    accountDigits: '99123456',
    issuer: 'Fictional Bank',
    reference: `REF-${fingerprint}`,
    merchant: 'Fictional Store',
    ...changes,
  });

  const source = (id: string, lastDigits = '123456') => ({
    id,
    kind: 'DEBIT',
    institution: 'Fictional Bank',
    lastDigits,
    balanceMinor: 123400,
  });

  const makeProfile = async (
    input: {
      paymentSourceId?: string;
      accountSuffix?: string;
      nickname?: string;
    } = {},
  ) =>
    service.saveProfile({
      paymentSourceId: input.paymentSourceId,
      bankName: 'Fictional Bank',
      accountSuffix: input.accountSuffix,
      nickname: input.nickname,
      owner: 'OWN',
    });

  beforeEach(() => {
    sources = [];
    profiles = new Map();
    events = new Map();
    candidates = new Map();
    statements = [];
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    TestBed.configureTestingModule({
      providers: [
        BankActivityService,
        { provide: SqliteDatabase, useValue: database },
        { provide: CardNestStore, useValue: { paymentSources: () => sources } },
      ],
    });
    service = TestBed.inject(BankActivityService);
  });

  afterEach(() => vi.restoreAllMocks());

  it('records a unique linked account match once without changing financial balances', async () => {
    sources = [source('source-one')];
    const profile = await makeProfile({ paymentSourceId: 'source-one' });
    const evidence = makeEvidence('unique-fingerprint');

    await expect(service.ingestAndroidSms(evidence)).resolves.toBe(true);
    await expect(service.ingestAndroidSms(evidence)).resolves.toBe(false);
    expect(service.events()).toHaveLength(1);
    expect(service.events()[0]).toMatchObject({
      profileId: profile.id,
      origin: 'ANDROID_SMS',
      verification: 'SOURCE_MATCHED',
    });
    expect(sources[0].balanceMinor).toBe(123400);
    expect(
      statements.some((statement) =>
        /payment_sources|card_transactions|source_balance/.test(statement),
      ),
    ).toBe(false);
  });

  it('queues a body-free candidate when multiple linked accounts share a bank and suffix', async () => {
    sources = [source('source-one'), source('source-two')];
    await makeProfile({ paymentSourceId: 'source-one', nickname: 'Primary' });
    await makeProfile({ paymentSourceId: 'source-two', nickname: 'Savings' });
    const evidence = {
      ...makeEvidence('ambiguous-fingerprint'),
      body: 'RAW SMS MUST NOT BE STORED',
    } as AndroidBankActivityEvidence;

    await expect(service.ingestAndroidSms(evidence)).resolves.toBe(false);
    expect(service.events()).toHaveLength(0);
    expect(service.candidates()).toHaveLength(1);
    expect(JSON.stringify(service.candidates()[0])).not.toContain('RAW SMS');
    expect(candidates.get('ambiguous-fingerprint')).not.toContain('RAW SMS');
  });

  it('records a unique standalone monitored account without requiring a linked source', async () => {
    const profile = await makeProfile({ accountSuffix: '456' });
    await expect(service.ingestAndroidSms(makeEvidence('standalone-fingerprint'))).resolves.toBe(
      true,
    );
    expect(service.events()).toHaveLength(1);
    expect(service.events()[0].profileId).toBe(profile.id);
  });

  it.each([
    ['unknown suffix', { accountDigits: '999000' }],
    ['absent suffix', { accountDigits: undefined }],
  ])('queues a review candidate for an %s', async (_label, changes) => {
    await makeProfile({ accountSuffix: '456' });
    await expect(service.ingestAndroidSms(makeEvidence(`suffix-${_label}`, changes))).resolves.toBe(
      false,
    );
    expect(service.events()).toHaveLength(0);
    expect(service.candidates()).toHaveLength(1);
  });

  it('keeps dismissed fingerprints as tombstones so rescans do not recreate suggestions', async () => {
    await makeProfile({ accountSuffix: '456' });
    const evidence = makeEvidence('dismissed-fingerprint', { accountDigits: undefined });
    await service.ingestAndroidSms(evidence);
    await service.dismissCandidate(evidence.fingerprint);
    expect(service.candidates()).toHaveLength(0);
    expect(JSON.parse(candidates.get(evidence.fingerprint) ?? '{}')).toMatchObject({
      dismissed: true,
    });

    await service.ingestAndroidSms(evidence);
    await service.reload();
    expect(service.candidates()).toHaveLength(0);
    expect(candidates.size).toBe(1);
  });

  it('does not queue qualifying bank evidence when no account is monitored', async () => {
    await expect(service.ingestAndroidSms(makeEvidence('unmonitored-fingerprint'))).resolves.toBe(
      false,
    );
    expect(service.candidates()).toHaveLength(0);
    expect(candidates.size).toBe(0);
  });
});
