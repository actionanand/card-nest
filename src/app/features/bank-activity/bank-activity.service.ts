import { Service, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { CardNestStore } from '../../core/services/card-nest-store';
import {
  BankActivityCandidate,
  BankActivityDirection,
  BankActivityEvent,
  BankActivityOrigin,
  BankActivityProfile,
  BankActivitySummary,
  bankActivitySummary,
} from './bank-activity-model';

export interface AndroidBankActivityEvidence {
  readonly fingerprint: string;
  readonly activityDate: string;
  readonly kind: string;
  readonly direction?: 'DEBIT' | 'CREDIT';
  readonly purposeHint?: string;
  readonly accountDigits?: string;
  readonly counterpartyAccountDigits?: string;
  readonly issuer?: string;
  readonly reference?: string;
  readonly dateFallback?: boolean;
  readonly merchant?: string;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function normalizedBank(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/\b(bank|limited|ltd|private|pvt|sms|alerts?)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  return normalized === 'statebankofindia' ? 'sbi' : normalized;
}

function matchesBank(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = normalizedBank(left);
  const b = normalizedBank(right);
  return a.length > 1 && a === b;
}

function finalThree(value: string | undefined): string | undefined {
  const digits = value?.replace(/\D/g, '');
  return digits && digits.length >= 3 ? digits.slice(-3) : undefined;
}

function safeReference(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && candidate.length <= 80 && /^[A-Za-z0-9._/-]+$/.test(candidate)
    ? candidate
    : undefined;
}

@Service()
export class BankActivityService {
  private readonly database = inject(SqliteDatabase);
  private readonly store = inject(CardNestStore);
  readonly profiles = signal<readonly BankActivityProfile[]>([]);
  readonly events = signal<readonly BankActivityEvent[]>([]);
  readonly candidates = signal<readonly BankActivityCandidate[]>([]);

  async initialise(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    if (!this.database.ready()) return;
    const [profiles, events, candidates] = await Promise.all([
      this.database.query<{ payload: string }>(
        'SELECT payload FROM bank_activity_profiles ORDER BY created_at DESC',
      ),
      this.database.query<{ payload: string }>(
        'SELECT payload FROM bank_activity_events ORDER BY activity_date DESC',
      ),
      this.database.query<{ payload: string }>(
        'SELECT payload FROM bank_activity_candidates ORDER BY created_at DESC',
      ),
    ]);
    this.profiles.set(profiles.map((row) => JSON.parse(row.payload) as BankActivityProfile));
    this.events.set(events.map((row) => JSON.parse(row.payload) as BankActivityEvent));
    this.candidates.set(
      candidates
        .map((row) => JSON.parse(row.payload) as BankActivityCandidate)
        .filter((candidate) => !candidate.dismissed),
    );
  }

  eventsFor(profileId: string): readonly BankActivityEvent[] {
    return this.events()
      .filter((event) => event.profileId === profileId)
      .slice()
      .sort((left, right) => right.activityDate.localeCompare(left.activityDate));
  }

  summaryFor(profileId: string, today: string): BankActivitySummary {
    return bankActivitySummary(this.eventsFor(profileId), today);
  }

  async saveProfile(input: {
    id?: string;
    paymentSourceId?: string;
    bankName: string;
    nickname?: string;
    accountSuffix?: string;
    owner: BankActivityProfile['owner'];
    holderName?: string;
    remarks?: string;
  }): Promise<BankActivityProfile> {
    const previous = input.id
      ? this.profiles().find((profile) => profile.id === input.id)
      : undefined;
    if (input.id && !previous) throw new Error('Bank Activity profile not found.');
    const source = input.paymentSourceId
      ? this.store
          .paymentSources()
          .find((item) => item.id === input.paymentSourceId && item.kind === 'DEBIT')
      : undefined;
    if (input.paymentSourceId && !source)
      throw new Error('Choose an existing CardNest bank account.');
    if (source && input.owner !== 'OWN')
      throw new Error(
        'Only an account marked as yours can link to an existing CardNest bank account.',
      );
    const bankName = (source?.institution || source?.nickname || input.bankName)
      .trim()
      .slice(0, 80);
    if (!bankName) throw new Error('Enter the bank name.');
    if (input.owner !== 'OWN' && input.owner !== 'OTHERS')
      throw new Error('Choose who owns this account.');
    const holderName = input.owner === 'OTHERS' ? input.holderName?.trim().slice(0, 80) : undefined;
    if (input.owner === 'OTHERS' && !holderName) throw new Error('Enter the account holder name.');
    const suffix = finalThree(source?.lastDigits ?? input.accountSuffix);
    if (input.accountSuffix && !/^\d{3,5}$/.test(input.accountSuffix))
      throw new Error('Enter only the final three to five account digits.');
    const timestamp = new Date().toISOString();
    const profile: BankActivityProfile = {
      id: previous?.id ?? crypto.randomUUID(),
      paymentSourceId: source?.id,
      bankName,
      nickname: input.nickname?.trim().slice(0, 80) || undefined,
      accountSuffix: suffix,
      owner: input.owner,
      holderName,
      remarks: input.remarks?.trim().slice(0, 300) || undefined,
      archived: previous?.archived ?? false,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const duplicate = this.profiles().find(
      (item) => item.paymentSourceId === profile.paymentSourceId && item.id !== profile.id,
    );
    if (profile.paymentSourceId && duplicate)
      throw new Error('This CardNest bank account is already monitored.');
    await this.database.run(
      `INSERT INTO bank_activity_profiles(id,payment_source_id,bank_name,archived,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payment_source_id=excluded.payment_source_id,bank_name=excluded.bank_name,archived=excluded.archived,payload=excluded.payload,updated_at=excluded.updated_at`,
      [
        profile.id,
        profile.paymentSourceId ?? null,
        profile.bankName,
        profile.archived ? 1 : 0,
        JSON.stringify(profile),
        profile.createdAt,
        timestamp,
      ],
    );
    this.profiles.update((items) => [profile, ...items.filter((item) => item.id !== profile.id)]);
    return profile;
  }

  async setArchived(profileId: string, archived: boolean): Promise<void> {
    const current = this.profiles().find((item) => item.id === profileId);
    if (!current) throw new Error('Bank Activity profile not found.');
    const updated = { ...current, archived, updatedAt: new Date().toISOString() };
    await this.database.run(
      'UPDATE bank_activity_profiles SET archived=?,payload=?,updated_at=? WHERE id=?',
      [archived ? 1 : 0, JSON.stringify(updated), updated.updatedAt, profileId],
    );
    this.profiles.update((items) => items.map((item) => (item.id === profileId ? updated : item)));
  }

  async saveManualEvent(input: {
    id?: string;
    profileId: string;
    activityDate: string;
    direction: BankActivityDirection;
    reference?: string;
  }): Promise<BankActivityEvent> {
    if (!validDate(input.activityDate)) throw new Error('Enter a valid activity date.');
    if (input.direction !== 'CREDIT' && input.direction !== 'DEBIT')
      throw new Error('Choose credit or debit.');
    const profile = this.profiles().find((item) => item.id === input.profileId && !item.archived);
    if (!profile) throw new Error('Choose an active monitored account.');
    return this.persistEvent({
      id: input.id,
      profileId: input.profileId,
      activityDate: input.activityDate,
      direction: input.direction,
      origin: 'MANUAL',
      verification: 'USER_CONFIRMED',
      reference: safeReference(input.reference),
    });
  }

  async ingestAndroidSms(input: AndroidBankActivityEvidence): Promise<boolean> {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return false;
    if (
      !input.fingerprint ||
      !validDate(input.activityDate) ||
      !input.direction ||
      input.dateFallback
    )
      return false;
    const validatedInput: AndroidBankActivityEvidence & {
      direction: BankActivityDirection;
      fingerprint: string;
      activityDate: string;
    } = {
      ...input,
      direction: input.direction,
      fingerprint: input.fingerprint,
      activityDate: input.activityDate,
    };
    const qualifyingKind = ['BANK_DEBIT', 'BANK_CREDIT', 'BANK_TRANSFER'].includes(input.kind);
    const allowedPurposes =
      input.direction === 'DEBIT'
        ? ['PURCHASE', 'ACCOUNT_TRANSFER', 'CARD_REPAYMENT', 'CASH_WITHDRAWAL']
        : ['INCOMING', 'ACCOUNT_TRANSFER'];
    const qualifyingPurpose = allowedPurposes.includes(input.purposeHint ?? '');
    if (!qualifyingKind || !qualifyingPurpose) return false;
    if (
      /\b(fee|charges?|annual maintenance|interest|balance enquiry|balance inquiry|failed|declined|promotion|auto.?debit|autopay|mandate|ecs|nach|emi)\b/i.test(
        input.merchant ?? '',
      )
    )
      return false;
    if (
      input.direction === 'CREDIT' &&
      input.purposeHint === 'INCOMING' &&
      !input.merchant?.trim() &&
      !input.counterpartyAccountDigits
    )
      return false;
    const [recorded] = await this.database.query<{ id: string }>(
      'SELECT id FROM bank_activity_events WHERE fingerprint=?',
      [input.fingerprint],
    );
    if (recorded) return false;
    const activeProfiles = this.profiles().filter((profile) => !profile.archived);
    const userSuffix = finalThree(input.accountDigits);
    const sources = this.store.paymentSources();
    const relevantProfiles = activeProfiles.filter((profile) => {
      const bankMatches = input.issuer ? matchesBank(profile.bankName, input.issuer) : false;
      const suffix =
        profile.accountSuffix ??
        finalThree(sources.find((source) => source.id === profile.paymentSourceId)?.lastDigits);
      return input.issuer ? bankMatches : !!userSuffix && suffix === userSuffix;
    });
    if (!relevantProfiles.length) return false;
    if (!userSuffix || !input.issuer) {
      await this.queueCandidate(validatedInput, userSuffix);
      return false;
    }
    const sourceMatches = sources.filter(
      (source) =>
        source.kind === 'DEBIT' &&
        finalThree(source.lastDigits) === userSuffix &&
        matchesBank(source.institution, input.issuer),
    );
    const matches = relevantProfiles.filter((profile) => {
      const suffix =
        profile.accountSuffix ??
        finalThree(sources.find((source) => source.id === profile.paymentSourceId)?.lastDigits);
      return suffix === userSuffix;
    });
    if (
      sourceMatches.length > 1 ||
      matches.length !== 1 ||
      (sourceMatches.length === 1 && matches[0]?.paymentSourceId !== sourceMatches[0].id)
    ) {
      await this.queueCandidate(validatedInput, userSuffix);
      return false;
    }
    try {
      await this.persistEvent({
        profileId: matches[0].id,
        activityDate: input.activityDate,
        direction: input.direction,
        origin: 'ANDROID_SMS',
        verification: 'SOURCE_MATCHED',
        reference: safeReference(input.reference),
        fingerprint: input.fingerprint,
      });
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return false;
      throw error;
    }
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.database.run('DELETE FROM bank_activity_events WHERE id=?', [eventId]);
    this.events.update((items) => items.filter((item) => item.id !== eventId));
  }

  async approveCandidate(
    fingerprint: string,
    profileId: string,
  ): Promise<BankActivityEvent | null> {
    const timestamp = new Date().toISOString();
    const event = await this.database.atomic(async (tx) => {
      const [candidateRow] = await tx.query<{ payload: string }>(
        'SELECT payload FROM bank_activity_candidates WHERE fingerprint=?',
        [fingerprint],
      );
      if (!candidateRow) throw new Error('This activity suggestion is no longer available.');
      const candidate = JSON.parse(candidateRow.payload) as BankActivityCandidate;
      if (candidate.dismissed)
        throw new Error('This activity suggestion was dismissed and cannot be confirmed.');
      const [profileRow] = await tx.query<{ payload: string; archived: number }>(
        'SELECT payload,archived FROM bank_activity_profiles WHERE id=?',
        [profileId],
      );
      if (!profileRow || profileRow.archived)
        throw new Error('Choose an active monitored account.');
      const [alreadyRecorded] = await tx.query<{ id: string }>(
        'SELECT id FROM bank_activity_events WHERE fingerprint=?',
        [fingerprint],
      );
      if (alreadyRecorded) {
        await tx.run('DELETE FROM bank_activity_candidates WHERE fingerprint=?', [fingerprint]);
        return null;
      }
      const record: BankActivityEvent = {
        id: crypto.randomUUID(),
        profileId,
        activityDate: candidate.activityDate,
        direction: candidate.direction,
        origin: 'ANDROID_SMS',
        verification: 'USER_CONFIRMED',
        reference: candidate.reference,
        fingerprint,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await tx.run(
        'INSERT INTO bank_activity_events(id,profile_id,activity_date,direction,origin,verification,fingerprint,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [
          record.id,
          record.profileId,
          record.activityDate,
          record.direction,
          record.origin,
          record.verification,
          record.fingerprint,
          JSON.stringify(record),
          record.createdAt,
          record.updatedAt,
        ],
      );
      await tx.run('DELETE FROM bank_activity_candidates WHERE fingerprint=?', [fingerprint]);
      return record;
    });
    this.candidates.update((items) => items.filter((item) => item.fingerprint !== fingerprint));
    if (event) this.events.update((items) => [event, ...items]);
    return event;
  }

  async dismissCandidate(fingerprint: string): Promise<void> {
    const [row] = await this.database.query<{ payload: string }>(
      'SELECT payload FROM bank_activity_candidates WHERE fingerprint=?',
      [fingerprint],
    );
    if (!row) return;
    const candidate = JSON.parse(row.payload) as BankActivityCandidate;
    if (!candidate.dismissed)
      await this.database.run('UPDATE bank_activity_candidates SET payload=? WHERE fingerprint=?', [
        JSON.stringify({ ...candidate, dismissed: true }),
        fingerprint,
      ]);
    this.candidates.update((items) => items.filter((item) => item.fingerprint !== fingerprint));
  }

  private async persistEvent(input: {
    id?: string;
    profileId: string;
    activityDate: string;
    direction: BankActivityDirection;
    origin: BankActivityOrigin;
    verification: BankActivityEvent['verification'];
    reference?: string;
    fingerprint?: string;
  }): Promise<BankActivityEvent> {
    const existing = input.id ? this.events().find((item) => item.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('Activity event not found.');
    const timestamp = new Date().toISOString();
    const event: BankActivityEvent = {
      id: existing?.id ?? crypto.randomUUID(),
      profileId: input.profileId,
      activityDate: input.activityDate,
      direction: input.direction,
      origin: existing?.origin ?? input.origin,
      verification: input.verification,
      reference: input.reference ?? existing?.reference,
      fingerprint: existing?.fingerprint ?? input.fingerprint,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.database.run(
      `INSERT INTO bank_activity_events(id,profile_id,activity_date,direction,origin,verification,fingerprint,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id,activity_date=excluded.activity_date,direction=excluded.direction,origin=excluded.origin,verification=excluded.verification,fingerprint=excluded.fingerprint,payload=excluded.payload,updated_at=excluded.updated_at`,
      [
        event.id,
        event.profileId,
        event.activityDate,
        event.direction,
        event.origin,
        event.verification,
        event.fingerprint ?? null,
        JSON.stringify(event),
        timestamp,
        timestamp,
      ],
    );
    this.events.update((items) => [event, ...items.filter((item) => item.id !== event.id)]);
    return event;
  }

  private async queueCandidate(
    input: AndroidBankActivityEvidence & {
      direction: BankActivityDirection;
      fingerprint: string;
      activityDate: string;
    },
    accountSuffix?: string,
  ): Promise<void> {
    const createdAt = new Date().toISOString();
    const candidate: BankActivityCandidate = {
      fingerprint: input.fingerprint,
      activityDate: input.activityDate,
      direction: input.direction,
      bankName: input.issuer?.trim().slice(0, 80),
      accountSuffix,
      reference: safeReference(input.reference),
      purposeHint: input.purposeHint ?? 'UNKNOWN',
      createdAt,
    };
    const inserted = await this.database.run(
      'INSERT OR IGNORE INTO bank_activity_candidates(fingerprint,payload,created_at) VALUES(?,?,?)',
      [candidate.fingerprint, JSON.stringify(candidate), createdAt],
    );
    if (!inserted) return;
    this.candidates.update((items) =>
      items.some((item) => item.fingerprint === candidate.fingerprint)
        ? items
        : [candidate, ...items],
    );
  }
}
