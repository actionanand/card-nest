import {
  activityMatch,
  bankDisplayName,
  finalThree,
  matchesBank,
  profileSuffix,
  selectionMatches,
} from './bank-activity-matching';
import { Service, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { DatabaseSession, SqliteDatabase } from '../../core/data/sqlite-database';
import { RECONCILE_BANK_ACTIVITY_LATEST } from '../../core/data/bank-activity-latest';
import { indiaTodayIso } from '../../core/services/india-date';
import { BankAccountSyncService } from './bank-account-sync.service';
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
  readonly parserVersion?: number;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    value <= indiaTodayIso() &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
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
  readonly accountSync = inject(BankAccountSyncService);
  readonly reviewNotice = signal('');
  readonly profiles = signal<readonly BankActivityProfile[]>([]);
  readonly events = signal<readonly BankActivityEvent[]>([]);
  readonly candidates = signal<readonly BankActivityCandidate[]>([]);

  async initialise(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    if (!this.database.ready()) return;
    try {
      const sources = await this.accountSync.reconcile();
      if (sources) this.store.paymentSources.set(sources);
    } catch (error: unknown) {
      this.accountSync.error.set(
        error instanceof Error ? error.message : 'Bank account synchronization failed.',
      );
    }
    await this.database.atomic(async (tx) => {
      for (const statement of RECONCILE_BANK_ACTIVITY_LATEST) await tx.run(statement);
      await this.compactCandidates(tx);
    });
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
        .filter((candidate) => !candidate.dismissed && !candidate.resolvedAt),
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
    manualOnly?: boolean;
    allowIdentityConflict?: boolean;
    confirmOwnershipSync?: boolean;
  }): Promise<BankActivityProfile> {
    const previous = input.id
      ? this.profiles().find((profile) => profile.id === input.id)
      : undefined;
    if (input.id && !previous) throw new Error('Bank Activity profile not found.');
    if (previous?.owner === 'OTHERS' && input.owner === 'OWN' && !input.confirmOwnershipSync)
      throw new Error(
        'Confirm that this is your account and may be synchronized with Money Sources.',
      );
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
    const bankName = (source?.institution || input.bankName || source?.nickname || '')
      .trim()
      .slice(0, 80);
    if (!bankName || !bankDisplayName(bankName))
      throw new Error('Enter a bank name without a complete account number.');
    if (input.owner !== 'OWN' && input.owner !== 'OTHERS')
      throw new Error('Choose who owns this account.');
    const holderName = input.owner === 'OTHERS' ? input.holderName?.trim().slice(0, 80) : undefined;
    if (input.owner === 'OTHERS' && !holderName) throw new Error('Enter the account holder name.');
    const sourceSuffix = finalThree(source?.lastDigits);
    const legacyUnchanged =
      !!previous &&
      input.accountSuffix === previous.accountSuffix &&
      !!finalThree(previous.accountSuffix);
    if (
      !sourceSuffix &&
      input.accountSuffix &&
      !/^\d{3}$/.test(input.accountSuffix) &&
      !legacyUnchanged
    )
      throw new Error('Enter exactly three numeric account digits.');
    const suffix = sourceSuffix ?? finalThree(input.accountSuffix);
    const manualOnly =
      input.manualOnly === true || (input.manualOnly === undefined && !!previous && !suffix);
    if (!suffix && !manualOnly)
      throw new Error(
        'Enter the last three account digits, or explicitly choose manual-only monitoring.',
      );
    const timestamp = new Date().toISOString();
    const profile: BankActivityProfile = {
      id: previous?.id ?? crypto.randomUUID(),
      paymentSourceId: source?.id,
      bankName,
      nickname: input.nickname?.trim().slice(0, 80) || undefined,
      accountSuffix: suffix,
      manualOnly,
      owner: input.owner,
      holderName,
      remarks: input.remarks?.trim().slice(0, 300) || undefined,
      archived: previous?.archived ?? false,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.database.atomic(async (tx) => {
      const records = (
        await tx.query<{ payload: string }>('SELECT payload FROM bank_activity_profiles')
      ).map((row) => JSON.parse(row.payload) as BankActivityProfile);
      if (
        profile.paymentSourceId &&
        records.some(
          (row) => row.id !== profile.id && row.paymentSourceId === profile.paymentSourceId,
        )
      )
        throw new Error(
          'This CardNest bank account is already monitored, possibly archived. Restore its existing profile.',
        );
      const collisions = records.filter(
        (row) =>
          row.id !== profile.id &&
          matchesBank(row.bankName, profile.bankName) &&
          profileSuffix(row, this.store.paymentSources()) === suffix &&
          !!suffix,
      );
      if (collisions.length) {
        const nickname = profile.nickname?.trim().toLowerCase(),
          holder = profile.holderName?.trim().toLowerCase();
        const distinct =
          !!(nickname || holder) &&
          collisions.every(
            (row) =>
              (nickname && nickname !== (row.nickname ?? '').trim().toLowerCase()) ||
              (holder && holder !== (row.holderName ?? '').trim().toLowerCase()),
          );
        if (!input.allowIdentityConflict || !distinct)
          throw new Error(
            'This bank and suffix already appear in monitoring, including archived profiles. For a genuinely distinct account, provide a distinguishing nickname or holder name and confirm the identity conflict.',
          );
      }
      await tx.run(
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
    });
    this.profiles.update((items) => [profile, ...items.filter((item) => item.id !== profile.id)]);
    await this.reload();
    return this.profiles().find((row) => row.id === profile.id) ?? profile;
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
    await this.reload();
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
      input.fingerprint.length > 150 ||
      (input.parserVersion !== undefined && input.parserVersion < 3) ||
      !validDate(input.activityDate) ||
      !['CREDIT', 'DEBIT'].includes(input.direction ?? '') ||
      input.dateFallback
    )
      return false;
    const validatedInput: AndroidBankActivityEvidence & {
      direction: BankActivityDirection;
      fingerprint: string;
      activityDate: string;
    } = {
      ...input,
      direction: input.direction as BankActivityDirection,
      fingerprint: input.fingerprint,
      activityDate: input.activityDate,
    };
    const qualifyingKind =
      ['BANK_DEBIT', 'BANK_CREDIT', 'BANK_TRANSFER'].includes(input.kind) &&
      (input.kind === 'BANK_TRANSFER' ||
        input.kind === (input.direction === 'DEBIT' ? 'BANK_DEBIT' : 'BANK_CREDIT'));
    const allowedPurposes =
      input.direction === 'DEBIT'
        ? ['PURCHASE', 'ACCOUNT_TRANSFER', 'CARD_REPAYMENT', 'CASH_WITHDRAWAL']
        : ['INCOMING', 'ACCOUNT_TRANSFER'];
    const qualifyingPurpose = allowedPurposes.includes(input.purposeHint ?? '');
    if (!qualifyingKind || !qualifyingPurpose) return false;
    if (
      /\b(fee|charges?|annual maintenance|interest|balance enquiry|balance inquiry|failed|declined|reversed|reversal|pending|scheduled|instruction|promotion|auto.?debit|autopay|mandate|ecs|nach|emi)\b/i.test(
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
    await this.queueCandidate(validatedInput, finalThree(input.accountDigits));
    return false;
  }

  match(candidate: BankActivityCandidate) {
    return activityMatch(candidate, this.profiles(), this.store.paymentSources());
  }
  selectionMatches(candidate: BankActivityCandidate, profileId: string): boolean {
    const profile = this.profiles().find((row) => row.id === profileId && !row.archived);
    return !!profile && selectionMatches(candidate, profile, this.store.paymentSources());
  }
  /** Explicit action: replay existing parsed evidence only. Never opens a device SMS provider. */
  readonly discovering = signal(false);
  readonly discoveryProgress = signal(0);
  async discoverSavedEvidence(): Promise<number> {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android')
      throw new Error(
        'Account discovery from messages is available on Android. Manual monitoring remains available.',
      );
    if (this.discovering()) return 0;
    this.discovering.set(true);
    this.discoveryProgress.set(0);
    let count = 0;
    try {
      const [marker] = await this.database.query<{ encrypted_value: string }>(
        "SELECT encrypted_value FROM app_preferences WHERE key='bank_activity_discovery_cursor'",
      );
      let cursor = Number(marker?.encrypted_value ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
      const [retention] = await this.database.query<{ value: string }>(
        "SELECT value FROM sms_sync_state WHERE key='retention_cutoff'",
      );
      for (let page = 0; page < 5; page++) {
        const rows = await this.database.query<{ rowid: number; payload: string }>(
          'SELECT rowid,payload FROM sms_candidates WHERE rowid>? AND payload IS NOT NULL ORDER BY rowid LIMIT 200',
          [cursor],
        );
        for (const row of rows) {
          count++;
          this.discoveryProgress.set(count);
          let value: unknown;
          try {
            value = JSON.parse(row.payload);
          } catch {
            continue;
          }
          if (value && typeof value === 'object') {
            const item = value as Record<string, unknown>;
            if (
              typeof item['id'] === 'string' &&
              typeof item['eventDate'] === 'string' &&
              typeof item['kind'] === 'string' &&
              typeof item['parserVersion'] === 'number' &&
              item['parserVersion'] >= 3 &&
              item['dateFallback'] === false &&
              (!retention || item['eventDate'] >= retention.value)
            ) {
              const text = (key: string) =>
                typeof item[key] === 'string' ? (item[key] as string) : undefined;
              await this.ingestAndroidSms({
                fingerprint: item['id'],
                activityDate: item['eventDate'],
                kind: item['kind'],
                direction:
                  item['direction'] === 'DEBIT' || item['direction'] === 'CREDIT'
                    ? item['direction']
                    : undefined,
                purposeHint: text('purposeHint'),
                issuer: text('issuer'),
                accountDigits: text('accountDigits'),
                counterpartyAccountDigits: text('counterpartyAccountDigits'),
                reference: text('reference'),
                merchant: text('merchant'),
                dateFallback: false,
                parserVersion: item['parserVersion'],
              });
            }
          }
        }
        cursor = rows.length === 200 ? rows.at(-1)!.rowid : 0;
        await this.database.run(
          "INSERT INTO app_preferences(key,encrypted_value) VALUES('bank_activity_discovery_cursor',?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value",
          [String(cursor)],
        );
        if (!cursor) break;
      }
      await this.reload();
      return count;
    } finally {
      this.discovering.set(false);
    }
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.database.atomic(async (tx) => {
      for (const statement of RECONCILE_BANK_ACTIVITY_LATEST.slice(0, 1)) await tx.run(statement);
      await tx.run('DELETE FROM bank_activity_events WHERE id=?', [eventId]);
    });
    this.events.update((items) => items.filter((item) => item.id !== eventId));
  }

  async approveCandidate(
    fingerprint: string,
    profileId: string,
    acknowledgeMismatch = false,
  ): Promise<BankActivityEvent | null> {
    this.reviewNotice.set('');
    const timestamp = new Date().toISOString();
    let notice = '';
    const event = await this.database.atomic(async (tx) => {
      const [candidateRow] = await tx.query<{ payload: string }>(
        'SELECT payload FROM bank_activity_candidates WHERE fingerprint=?',
        [fingerprint],
      );
      const [recorded] = await tx.query<{ id: string }>(
        'SELECT id FROM bank_activity_events WHERE fingerprint=?',
        [fingerprint],
      );
      if (recorded) return null;
      if (!candidateRow) throw new Error('This activity suggestion is no longer available.');
      const candidate = JSON.parse(candidateRow.payload) as BankActivityCandidate;
      if (candidate.resolvedAt) return null;
      if (candidate.dismissed)
        throw new Error('This activity suggestion was dismissed and cannot be confirmed.');
      const [profileRow] = await tx.query<{ payload: string; archived: number }>(
        'SELECT payload,archived FROM bank_activity_profiles WHERE id=?',
        [profileId],
      );
      if (!profileRow || profileRow.archived)
        throw new Error('Choose an active monitored account.');
      const profile = JSON.parse(profileRow.payload) as BankActivityProfile;
      if (
        candidate.fingerprint !== fingerprint ||
        (candidate.kind !== undefined &&
          !['BANK_DEBIT', 'BANK_CREDIT', 'BANK_TRANSFER'].includes(candidate.kind)) ||
        !validDate(candidate.activityDate) ||
        !['CREDIT', 'DEBIT'].includes(candidate.direction) ||
        !(
          candidate.direction === 'DEBIT'
            ? ['PURCHASE', 'ACCOUNT_TRANSFER', 'CARD_REPAYMENT', 'CASH_WITHDRAWAL']
            : ['INCOMING', 'ACCOUNT_TRANSFER']
        ).includes(candidate.purposeHint)
      )
        throw new Error('This activity evidence is invalid or no longer qualifies.');
      if (
        !selectionMatches(candidate, profile, this.store.paymentSources()) &&
        !acknowledgeMismatch
      )
        throw new Error(
          'The selected account conflicts with the evidence or cannot be verified. Explicitly acknowledge independent account verification before confirming.',
        );
      const [latest] = await tx.query<{ activity_date: string }>(
        'SELECT activity_date FROM bank_activity_events WHERE profile_id=? AND direction=? ORDER BY activity_date DESC LIMIT 1',
        [profileId, candidate.direction],
      );
      if (latest && latest.activity_date >= candidate.activityDate) {
        await tx.run('UPDATE bank_activity_candidates SET payload=? WHERE fingerprint=?', [
          JSON.stringify({
            ...candidate,
            dismissed: true,
            resolvedAt: timestamp,
            resolvedProfileId: profileId,
          }),
          fingerprint,
        ]);
        notice = `This account already has a ${candidate.direction.toLowerCase()} on ${latest.activity_date}. The older or same-date suggestion has been dismissed.`;
        return null;
      }
      await tx.run('DELETE FROM bank_activity_events WHERE profile_id=? AND direction=?', [
        profileId,
        candidate.direction,
      ]);
      const record: BankActivityEvent = {
        id: crypto.randomUUID(),
        profileId,
        activityDate: candidate.activityDate,
        direction: candidate.direction,
        origin: 'ANDROID_SMS',
        verification: 'USER_CONFIRMED',
        reference: safeReference(candidate.reference),
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
      await tx.run('UPDATE bank_activity_candidates SET payload=? WHERE fingerprint=?', [
        JSON.stringify({ ...candidate, resolvedAt: timestamp, resolvedProfileId: profileId }),
        fingerprint,
      ]);
      await this.compactCandidates(tx);
      return record;
    });
    this.reviewNotice.set(notice);
    this.candidates.update((items) => items.filter((item) => item.fingerprint !== fingerprint));
    if (event)
      this.events.update((items) => [
        event,
        ...items.filter(
          (row) => row.profileId !== event.profileId || row.direction !== event.direction,
        ),
      ]);
    await this.reload();
    return event;
  }

  async dismissCandidate(fingerprint: string): Promise<void> {
    await this.dismissCandidates([fingerprint]);
  }
  async dismissCandidates(fingerprints: readonly string[]): Promise<void> {
    await this.database.atomic(async (tx) => {
      for (const fingerprint of fingerprints) {
        const [row] = await tx.query<{ payload: string }>(
          'SELECT payload FROM bank_activity_candidates WHERE fingerprint=?',
          [fingerprint],
        );
        if (!row) continue;
        const candidate = JSON.parse(row.payload) as BankActivityCandidate;
        if (!candidate.dismissed && !candidate.resolvedAt)
          await tx.run('UPDATE bank_activity_candidates SET payload=? WHERE fingerprint=?', [
            JSON.stringify({ ...candidate, dismissed: true }),
            fingerprint,
          ]);
      }
    });
    this.candidates.update((items) =>
      items.filter((row) => !fingerprints.includes(row.fingerprint)),
    );
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
    await this.database.atomic(async (tx) => {
      const [profile] = await tx.query<{ archived: number }>(
        'SELECT payload,archived FROM bank_activity_profiles WHERE id=?',
        [event.profileId],
      );
      if (!profile || profile.archived) throw new Error('Choose an active monitored account.');
      const [latest] = await tx.query<{ id: string; activity_date: string }>(
        'SELECT id,activity_date FROM bank_activity_events WHERE profile_id=? AND direction=? ORDER BY activity_date DESC LIMIT 1',
        [event.profileId, event.direction],
      );
      if (input.id && latest?.id !== input.id)
        throw new Error('The latest activity changed. Reopen the account before correcting it.');
      if (latest && latest.id !== input.id && latest.activity_date >= event.activityDate)
        throw new Error(
          `This account already has a ${event.direction.toLowerCase()} on ${latest.activity_date}. Use Correct activity date for an intentional correction.`,
        );
      if (
        existing &&
        (existing.profileId !== input.profileId || existing.direction !== input.direction)
      )
        throw new Error('A date correction must keep the same account and direction.');
      for (const statement of RECONCILE_BANK_ACTIVITY_LATEST.slice(0, 1)) await tx.run(statement);
      await tx.run('DELETE FROM bank_activity_events WHERE profile_id=? AND direction=?', [
        event.profileId,
        event.direction,
      ]);
      await tx.run(
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
          event.createdAt,
          timestamp,
        ],
      );
      await this.compactCandidates(tx);
    });
    this.events.update((items) => [
      event,
      ...items.filter(
        (item) => item.profileId !== event.profileId || item.direction !== event.direction,
      ),
    ]);
    await this.reload();
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
      bankName: bankDisplayName(input.issuer),
      kind: input.kind,
      accountSuffix,
      reference: safeReference(input.reference),
      purposeHint: input.purposeHint ?? 'UNKNOWN',
      createdAt,
    };
    const result = await this.database.atomic(async (tx) => {
      const inserted = await tx.run(
        'INSERT OR IGNORE INTO bank_activity_candidates(fingerprint,payload,created_at) VALUES(?,?,?)',
        [candidate.fingerprint, JSON.stringify(candidate), createdAt],
      );
      const pending = await this.compactCandidates(tx);
      let notice = '';
      const match = this.match(candidate);
      if (
        inserted &&
        match.suggestedId &&
        !pending.some((row) => row.fingerprint === candidate.fingerprint)
      ) {
        const [latest] = await tx.query<{ activity_date: string }>(
          'SELECT activity_date FROM bank_activity_events WHERE profile_id=? AND direction=? ORDER BY activity_date DESC LIMIT 1',
          [match.suggestedId, candidate.direction],
        );
        if (latest && latest.activity_date >= candidate.activityDate)
          notice = `This account already has a ${candidate.direction.toLowerCase()} on ${latest.activity_date}. The older or same-date suggestion has been dismissed.`;
      }
      return { pending, notice };
    });
    this.candidates.set(result.pending);
    if (result.notice) this.reviewNotice.set(result.notice);
  }

  /** Only a uniquely established identity permits compaction; ambiguity stays reviewable. */
  private async compactCandidates(tx: DatabaseSession): Promise<readonly BankActivityCandidate[]> {
    const profileRows = await tx.query<{ payload: string }>(
      'SELECT payload FROM bank_activity_profiles',
    );
    const profiles = profileRows.map((row) => JSON.parse(row.payload) as BankActivityProfile);
    const eventRows = await tx.query<{ payload: string }>(
      'SELECT payload FROM bank_activity_events',
    );
    const events = eventRows.map((row) => JSON.parse(row.payload) as BankActivityEvent);
    const rows = await tx.query<{ payload: string }>(
      'SELECT payload FROM bank_activity_candidates ORDER BY created_at ASC,fingerprint ASC',
    );
    const pending = rows
      .map((row) => JSON.parse(row.payload) as BankActivityCandidate)
      .filter((row) => !row.dismissed && !row.resolvedAt)
      .sort(
        (a, b) =>
          b.activityDate.localeCompare(a.activityDate) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.fingerprint.localeCompare(b.fingerprint),
      );
    const kept = new Set<string>();
    const result: BankActivityCandidate[] = [];
    for (const candidate of pending) {
      const match = activityMatch(candidate, profiles, this.store.paymentSources());
      if (match.state !== 'UNIQUE' || !match.suggestedId) {
        result.push(candidate);
        continue;
      }
      const key = match.suggestedId + ':' + candidate.direction;
      const latest = events.find(
        (event) => event.profileId === match.suggestedId && event.direction === candidate.direction,
      );
      if ((latest && latest.activityDate >= candidate.activityDate) || kept.has(key)) {
        await tx.run('UPDATE bank_activity_candidates SET payload=? WHERE fingerprint=?', [
          JSON.stringify({
            fingerprint: candidate.fingerprint,
            dismissed: true,
            resolvedProfileId: match.suggestedId,
            resolvedAt: new Date().toISOString(),
          }),
          candidate.fingerprint,
        ]);
      } else {
        kept.add(key);
        result.push(candidate);
      }
    }
    return result;
  }
}
