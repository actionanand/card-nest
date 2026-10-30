import { Service, inject, signal } from '@angular/core';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { PaymentSource } from '../../core/models/domain';
import { parseBankCashTracking } from '../../core/services/source-balance';
import { BankActivityProfile } from './bank-activity-model';
import { bankDisplayName, finalThree, matchesBank } from './bank-activity-matching';

/** Identity-only coordinator. It has no dependency on either store or monitoring service. */
@Service()
export class BankAccountSyncService {
  private readonly database = inject(SqliteDatabase);
  readonly conflicts = signal<readonly string[]>([]);
  readonly error = signal<string | null>(null);

  async reconcile(): Promise<readonly PaymentSource[] | null> {
    if (!this.database.ready()) return null;
    const result = await this.database.atomic(async (tx) => {
      const preferences = await tx.query<{ key: string; encrypted_value: string }>(
        "SELECT key,encrypted_value FROM app_preferences WHERE key IN ('payment_sources','bank_cash_tracking')",
      );
      const values = new Map(preferences.map((row) => [row.key, row.encrypted_value]));
      const trackingEnabled = parseBankCashTracking(values.get('bank_cash_tracking')).enabled;
      const raw: unknown = JSON.parse(values.get('payment_sources') ?? '[]');
      if (!Array.isArray(raw)) throw new Error('Saved Money Sources are invalid.');
      const sources = raw as PaymentSource[];
      const rows = await tx.query<{ payload: string }>(
        'SELECT payload FROM bank_activity_profiles',
      );
      const profiles = rows.map((row) => JSON.parse(row.payload) as BankActivityProfile);
      const changed = new Map<string, BankActivityProfile>();
      const conflicts: string[] = [];
      let sourcesChanged = false;
      const timestamp = new Date().toISOString();
      const eligible = (profile: BankActivityProfile) =>
        profile.owner === 'OWN' &&
        !profile.archived &&
        !profile.manualOnly &&
        !!finalThree(profile.accountSuffix);
      const fingerprintsProveDifferent = (left?: string, right?: string) =>
        !!left && !!right && left !== right;
      const sameAccountIdentity = (profile: BankActivityProfile, source: PaymentSource) =>
        matchesBank(profile.bankName, source.institution) &&
        finalThree(profile.accountSuffix) === finalThree(source.lastDigits) &&
        !fingerprintsProveDifferent(profile.accountFingerprint, source.accountFingerprint);
      const compatible = sameAccountIdentity;
      const link = (profile: BankActivityProfile, source: PaymentSource) => {
        const next = { ...profile, paymentSourceId: source.id, updatedAt: timestamp };
        profiles[profiles.findIndex((row) => row.id === profile.id)] = next;
        changed.set(next.id, next);
      };
      for (const profile of [...profiles]) {
        if (profile.paymentSourceId) {
          const source = sources.find((row) => row.id === profile.paymentSourceId);
          if (source?.archived && !profile.archived)
            conflicts.push(
              `${profile.bankName}: linked Money Source is archived. Restore it in Money Sources or archive this monitoring profile; its stable link and history are preserved.`,
            );
          if (
            profile.owner !== 'OWN' ||
            !source ||
            source.kind !== 'DEBIT' ||
            !compatible(profile, source)
          )
            conflicts.push(
              `${profile.bankName}: linked identity changed. Edit the monitored account and explicitly select the intended Money Source.`,
            );
          continue;
        }
        if (!eligible(profile)) continue;
        const candidates = sources.filter(
          (row) => row.kind === 'DEBIT' && compatible(profile, row),
        );
        const peers = profiles.filter(
          (row) =>
            matchesBank(row.bankName, profile.bankName) &&
            finalThree(row.accountSuffix) === finalThree(profile.accountSuffix) &&
            !fingerprintsProveDifferent(row.accountFingerprint, profile.accountFingerprint),
        );
        if (
          candidates.length > 1 ||
          peers.length > 1 ||
          candidates.some(
            (source) =>
              source.archived || profiles.some((row) => row.paymentSourceId === source.id),
          )
        ) {
          conflicts.push(
            `${profile.bankName} · •••${profile.accountSuffix}: account needs identification. Edit the profile and choose its existing Money Source explicitly.`,
          );
          continue;
        }
        if (candidates.length === 1) {
          link(profile, candidates[0]);
          continue;
        }
        const bank = bankDisplayName(profile.bankName);
        if (!bank) continue;
        const source: PaymentSource = {
          id: `bank-${crypto.randomUUID()}`,
          kind: 'DEBIT',
          institution: bank,
          nickname: profile.nickname || bank,
          lastDigits: profile.accountSuffix,
          accountMask: profile.accountMask,
          accountFingerprint: profile.accountFingerprint,
          ifscCode: profile.ifscCode,
          isPrimaryBank: !sources.some(
            (candidate) =>
              candidate.kind === 'DEBIT' &&
              candidate.archived !== true &&
              candidate.id !== 'source-debit' &&
              candidate.institution !== 'Primary bank',
          ),
          archived: false,
          noLimit: true,
          autoLoad: false,
        };
        sources.push(source);
        for (const placeholder of sources) {
          if (placeholder.id === 'source-debit' && placeholder.kind === 'DEBIT') {
            placeholder.archived = true;
            placeholder.isPrimaryBank = false;
          }
        }
        sourcesChanged = true;
        link(profile, source);
      }
      if (trackingEnabled)
        for (const source of sources) {
          if (
            source.kind !== 'DEBIT' ||
            source.archived ||
            !finalThree(source.lastDigits) ||
            !bankDisplayName(source.institution)
          )
            continue;
          if (profiles.some((row) => row.paymentSourceId === source.id)) continue;
          const possible = profiles.filter((row) => compatible(row, source));
          const peers = sources.filter(
            (row) =>
              row.kind === 'DEBIT' &&
              matchesBank(row.institution, source.institution) &&
              finalThree(row.lastDigits) === finalThree(source.lastDigits),
          );
          if (possible.length || peers.length > 1) {
            conflicts.push(
              `${source.nickname}: account needs identification. Select the intended source in an OWN monitoring profile; family and archived profiles are preserved.`,
            );
            continue;
          }
          const profile: BankActivityProfile = {
            id: crypto.randomUUID(),
            bankName: bankDisplayName(source.institution)!,
            nickname: source.nickname,
            accountSuffix: finalThree(source.lastDigits),
            paymentSourceId: source.id,
            owner: 'OWN',
            archived: false,
            manualOnly: false,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          profiles.push(profile);
          changed.set(profile.id, profile);
        }
      for (const profile of changed.values())
        await tx.run(
          'INSERT INTO bank_activity_profiles(id,payment_source_id,bank_name,archived,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payment_source_id=excluded.payment_source_id,payload=excluded.payload,updated_at=excluded.updated_at',
          [
            profile.id,
            profile.paymentSourceId ?? null,
            profile.bankName,
            profile.archived ? 1 : 0,
            JSON.stringify(profile),
            profile.createdAt,
            profile.updatedAt,
          ],
        );
      if (sourcesChanged)
        await tx.run(
          "INSERT INTO app_preferences(key,encrypted_value) VALUES('payment_sources',?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value",
          [JSON.stringify(sources)],
        );
      return { sources: sourcesChanged ? sources : null, conflicts };
    });
    this.conflicts.set(result.conflicts);
    this.error.set(null);
    return result.sources;
  }
}
