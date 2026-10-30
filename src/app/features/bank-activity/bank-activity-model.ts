export type BankActivityOwner = 'OWN' | 'OTHERS';
export type BankActivityDirection = 'CREDIT' | 'DEBIT';
export type BankActivityOrigin = 'MANUAL' | 'ANDROID_SMS';
export type BankActivityVerification = 'USER_CONFIRMED' | 'SOURCE_MATCHED';

export interface BankActivityProfile {
  readonly manualOnly?: boolean;
  readonly id: string;
  readonly paymentSourceId?: string;
  readonly bankName: string;
  readonly nickname?: string;
  readonly accountSuffix?: string;
  readonly accountMask?: string;
  readonly accountFingerprint?: string;
  readonly ifscCode?: string;
  readonly owner: BankActivityOwner;
  readonly holderName?: string;
  readonly remarks?: string;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BankActivityEvent {
  readonly id: string;
  readonly profileId: string;
  readonly activityDate: string;
  readonly direction: BankActivityDirection;
  readonly origin: BankActivityOrigin;
  readonly verification: BankActivityVerification;
  readonly reference?: string;
  readonly fingerprint?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BankActivityCandidate {
  readonly kind?: string;
  readonly resolvedAt?: string;
  readonly resolvedProfileId?: string;
  readonly fingerprint: string;
  readonly activityDate: string;
  readonly direction: BankActivityDirection;
  readonly bankName?: string;
  readonly accountSuffix?: string;
  readonly accountMask?: string;
  readonly reference?: string;
  readonly purposeHint: string;
  readonly createdAt: string;
  readonly dismissed?: boolean;
}

export type BankActivityStatus =
  'RECENTLY_USED' | 'NOT_USED_RECENTLY' | 'LONG_INACTIVE' | 'UNKNOWN';

export interface BankActivitySummary {
  readonly status: BankActivityStatus;
  readonly daysSinceActivity: number | null;
  readonly calendarMonths: number | null;
  readonly lastActivityDate?: string;
}

function validActivityDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function bankActivitySummary(
  events: readonly BankActivityEvent[],
  today: string,
): BankActivitySummary {
  const last = events
    .map((event) => event.activityDate)
    .filter((date) => validActivityDate(date) && date <= today)
    .sort()
    .at(-1);
  if (!last) return { status: 'UNKNOWN', daysSinceActivity: null, calendarMonths: null };
  const [lastYear, lastMonth, lastDay] = last.split('-').map(Number);
  const [todayYear, todayMonth, todayDay] = today.split('-').map(Number);
  const elapsedMonths = Math.max(
    0,
    (todayYear - lastYear) * 12 + todayMonth - lastMonth - (todayDay < lastDay ? 1 : 0),
  );
  const daysSinceActivity = Math.max(
    0,
    Math.round(
      (Date.UTC(todayYear, todayMonth - 1, todayDay) - Date.UTC(lastYear, lastMonth - 1, lastDay)) /
        86_400_000,
    ),
  );
  return {
    status:
      elapsedMonths >= 12
        ? 'LONG_INACTIVE'
        : elapsedMonths >= 6
          ? 'NOT_USED_RECENTLY'
          : 'RECENTLY_USED',
    daysSinceActivity,
    calendarMonths: elapsedMonths,
    lastActivityDate: last,
  };
}
