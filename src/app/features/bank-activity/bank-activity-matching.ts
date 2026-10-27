import aliases from './data/bank-aliases.json';
import type { BankActivityCandidate, BankActivityProfile } from './bank-activity-model';
import type { PaymentSource } from '../../core/models/domain';

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
    'UNIQUE' | 'AMBIGUOUS' | 'BANK_MISMATCH' | 'SUFFIX_MISMATCH' | 'MISSING' | 'ARCHIVED' | 'NEW';
  profileIds: readonly string[];
  suggestedId?: string;
  reason: string;
}
export function activityMatch(
  candidate: BankActivityCandidate,
  profiles: readonly BankActivityProfile[],
  sources: readonly Pick<PaymentSource, 'id' | 'kind' | 'institution' | 'lastDigits'>[],
): ActivityMatch {
  const bank = normalizedBank(candidate.bankName),
    suffix = finalThree(candidate.accountSuffix);
  if (!bank || !suffix)
    return {
      state: 'MISSING',
      profileIds: [],
      reason:
        'Bank identity or originating account digits are unavailable. Verify the account independently; no account is source-verified.',
    };
  const exact = profiles.filter((row) => selectionMatches(candidate, row, sources));
  const active = exact.filter((row) => !row.archived);
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
    (!sourceMatches.length ||
      !active[0].paymentSourceId ||
      active[0].paymentSourceId === sourceMatches[0].id)
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
      profileIds: active.map((row) => row.id),
      reason:
        'Several accounts or linked sources may share this bank and suffix. Choose the correct account explicitly.',
    };
  if (exact.some((row) => row.archived))
    return {
      state: 'ARCHIVED',
      profileIds: [],
      reason:
        'This evidence may belong to an archived account. Restore it explicitly or identify a distinct account; no history is relinked automatically.',
    };
  if (profiles.some((row) => !row.archived && matchesBank(row.bankName, candidate.bankName)))
    return {
      state: 'SUFFIX_MISMATCH',
      profileIds: [],
      reason:
        'The bank is monitored, but its account suffix does not match an SMS-enabled profile. Review or add a separate account.',
    };
  if (profiles.some((row) => !row.archived && profileSuffix(row, sources) === suffix))
    return {
      state: 'BANK_MISMATCH',
      profileIds: [],
      reason:
        'These final three digits appear on a different bank. Verify bank identity before choosing an account.',
    };
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
