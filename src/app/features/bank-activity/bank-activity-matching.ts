import aliases from './data/bank-aliases.json';
import type { BankActivityCandidate, BankActivityProfile } from './bank-activity-model';
import type { PaymentSource } from '../../core/models/domain';

type BankSourceIdentity = Pick<PaymentSource, 'id' | 'kind' | 'institution' | 'lastDigits'> &
  Partial<Pick<PaymentSource, 'archived'>>;

function bankKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\b(limited|ltd|private|pvt|sms|alerts?)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}
export function normalizedBank(value: string | undefined): string {
  if (!value) return '';
  const key = bankKey(value);
  return aliases.find((row) => row.aliases.some((alias) => bankKey(alias) === key))?.id ?? key;
}
export function bankDisplayName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.trim().slice(0, 80);
  if (/\d{6,}|[\r\n]/.test(clean)) return undefined;
  return aliases.find((row) => row.id === normalizedBank(clean))?.name ?? clean;
}
export function matchesBank(left: string | undefined, right: string | undefined): boolean {
  const a = normalizedBank(left),
    b = normalizedBank(right);
  return a.length > 1 && a === b;
}
export function recognizedBank(value: string | undefined): boolean {
  if (!value) return false;
  const key = bankKey(value);
  return aliases.some(
    (row) => bankKey(row.id) === key || row.aliases.some((alias) => bankKey(alias) === key),
  );
}
export function finalThree(value: string | undefined): string | undefined {
  return value && /^\d{3,5}$/.test(value) ? value.slice(-3) : undefined;
}
export function profileSuffix(
  profile: BankActivityProfile,
  sources: readonly Pick<PaymentSource, 'id' | 'lastDigits'>[],
): string | undefined {
  return (
    finalThree(profile.accountSuffix) ??
    finalThree(sources.find((row) => row.id === profile.paymentSourceId)?.lastDigits)
  );
}
export interface ActivityMatch {
  state:
    | 'UNIQUE'
    | 'AMBIGUOUS'
    | 'BANK_MISMATCH'
    | 'SUFFIX_MISMATCH'
    | 'MISSING'
    | 'ARCHIVED'
    | 'SOURCE_ONLY'
    | 'NEW';
  profileIds: readonly string[];
  suggestedId?: string;
  sourceId?: string;
  reason: string;
}
export function activityMatch(
  candidate: BankActivityCandidate,
  profiles: readonly BankActivityProfile[],
  sources: readonly BankSourceIdentity[],
): ActivityMatch {
  const suffix = finalThree(candidate.accountSuffix);
  if (!suffix)
    return {
      state: 'MISSING',
      profileIds: [],
      reason:
        'Originating account digits are unavailable. Verify the account independently; no account is source-verified.',
    };
  const exact = profiles.filter((row) => selectionMatches(candidate, row, sources));
  const active = exact.filter((row) => {
    const source = row.paymentSourceId
      ? sources.find((source) => source.id === row.paymentSourceId)
      : undefined;
    return !row.archived && !source?.archived;
  });
  const sourceMatches = sources.filter(
    (row) =>
      row.kind === 'DEBIT' &&
      matchesBank(row.institution, candidate.bankName) &&
      finalThree(row.lastDigits) === suffix,
  );
  if (
    active.length === 1 &&
    exact.length === 1 &&
    sourceMatches.length <= 1 &&
    (!sourceMatches.length || active[0].paymentSourceId === sourceMatches[0].id)
  )
    return {
      state: 'UNIQUE',
      profileIds: [active[0].id],
      suggestedId: active[0].id,
      reason:
        'Bank and final three digits match one monitored account. This is a suggestion, not proof of ownership; confirmation is required.',
    };
  if (active.length)
    return {
      state: 'AMBIGUOUS',
      profileIds: exact.map((row) => row.id),
      reason:
        'Several accounts or linked sources may share this bank and suffix. Choose the correct account explicitly.',
    };
  if (!exact.length && sourceMatches.length > 1)
    return {
      state: 'AMBIGUOUS',
      profileIds: [],
      reason:
        'Several saved bank sources match this bank and suffix. Choose or link the intended account explicitly.',
    };
  if (!exact.length && sourceMatches.some((row) => row.archived))
    return {
      state: 'ARCHIVED',
      profileIds: [],
      reason:
        'The matching Money Source is archived. Restore it explicitly; no account is selected automatically.',
    };
  if (!exact.length && sourceMatches.length === 1)
    return {
      state: 'SOURCE_ONLY',
      profileIds: [],
      sourceId: sourceMatches[0].id,
      reason:
        'A saved bank source matches this bank and suffix but has no monitoring profile. Link it explicitly before reviewing activity.',
    };
  if (
    exact.some((row) => {
      const source = row.paymentSourceId
        ? sources.find((source) => source.id === row.paymentSourceId)
        : undefined;
      return row.archived || source?.archived;
    })
  )
    return {
      state: 'ARCHIVED',
      profileIds: [],
      reason:
        'This evidence may belong to an archived account. Restore it explicitly or identify a distinct account; no history is relinked automatically.',
    };
  const hasTrustworthyBank =
    recognizedBank(candidate.bankName) ||
    profiles.some((row) => matchesBank(row.bankName, candidate.bankName)) ||
    sources.some((row) => matchesBank(row.institution, candidate.bankName));
  const sameBankProfile = profiles.some((row) => matchesBank(row.bankName, candidate.bankName));
  const sameBankSource = sources.some(
    (row) => row.kind === 'DEBIT' && matchesBank(row.institution, candidate.bankName),
  );
  if (hasTrustworthyBank && (sameBankProfile || sameBankSource))
    return {
      state: 'SUFFIX_MISMATCH',
      profileIds: [],
      reason:
        'The bank is monitored, but its account suffix does not match an SMS-enabled profile. Review or add a separate account.',
    };
  if (
    hasTrustworthyBank &&
    (profiles.some((row) => profileSuffix(row, sources) === suffix) ||
      sources.some((row) => row.kind === 'DEBIT' && finalThree(row.lastDigits) === suffix))
  )
    return {
      state: 'BANK_MISMATCH',
      profileIds: [],
      reason:
        'These final three digits appear on a different bank. Verify bank identity before choosing an account.',
    };
  if (!hasTrustworthyBank) {
    const accounts = new Map<
      string,
      { profileId?: string; sourceId?: string; archived: boolean }
    >();
    for (const profile of profiles) {
      if (profile.manualOnly || profileSuffix(profile, sources) !== suffix) continue;
      const source = profile.paymentSourceId
        ? sources.find((row) => row.id === profile.paymentSourceId)
        : undefined;
      const id = profile.paymentSourceId ?? `profile:${profile.id}`;
      accounts.set(id, {
        profileId: profile.id,
        sourceId: profile.paymentSourceId,
        archived: profile.archived || !!source?.archived,
      });
    }
    for (const source of sources) {
      if (source.kind !== 'DEBIT' || finalThree(source.lastDigits) !== suffix) continue;
      const linkedProfile = profiles.find((row) => row.paymentSourceId === source.id);
      if (linkedProfile?.manualOnly) continue;
      const existing = accounts.get(source.id);
      accounts.set(source.id, {
        profileId: existing?.profileId,
        sourceId: source.id,
        archived: !!source.archived || !!existing?.archived,
      });
    }
    if (accounts.size > 1)
      return {
        state: 'AMBIGUOUS',
        profileIds: [...accounts.values()]
          .map((account) => account.profileId)
          .filter((id): id is string => !!id),
        reason:
          'The final three digits match multiple saved accounts. Choose one explicitly; suffix digits do not prove bank identity.',
      };
    const [account] = accounts.values();
    if (account?.archived)
      return {
        state: 'ARCHIVED',
        profileIds: [],
        reason:
          'The final three digits match an archived account. Restore or identify an active account explicitly; nothing is selected automatically.',
      };
    if (account?.profileId)
      return {
        state: 'UNIQUE',
        profileIds: [account.profileId],
        suggestedId: account.profileId,
        sourceId: account.sourceId,
        reason:
          'Only one active account has these final three digits. This suffix-only suggestion requires explicit account confirmation and does not prove bank identity or approve activity.',
      };
    if (account?.sourceId)
      return {
        state: 'SOURCE_ONLY',
        profileIds: [],
        sourceId: account.sourceId,
        reason:
          'One saved bank source has these final three digits but has no monitoring profile. Link it explicitly before reviewing activity.',
      };
  }
  return {
    state: 'NEW',
    profileIds: [],
    reason:
      'No monitored account matches this bank and suffix. Review a provisional discovery; ownership is not confirmed.',
  };
}
export function selectionMatches(
  candidate: BankActivityCandidate,
  profile: BankActivityProfile,
  sources: readonly Pick<PaymentSource, 'id' | 'lastDigits' | 'institution'>[],
): boolean {
  const source = profile.paymentSourceId
    ? sources.find((row) => row.id === profile.paymentSourceId)
    : undefined;
  if (profile.paymentSourceId && !source) return false;
  if (source?.institution && !matchesBank(source.institution, profile.bankName)) return false;
  const storedSuffix = finalThree(profile.accountSuffix),
    linkedSuffix = finalThree(source?.lastDigits);
  if (storedSuffix && linkedSuffix && storedSuffix !== linkedSuffix) return false;
  return (
    !profile.manualOnly &&
    !!candidate.accountSuffix &&
    matchesBank(candidate.bankName, profile.bankName) &&
    finalThree(candidate.accountSuffix) === profileSuffix(profile, sources)
  );
}
