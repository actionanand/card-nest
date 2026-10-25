import { indiaTodayIso } from '../../core/services/india-date';
import { LpgEvent, MobileRecharge } from './utilities-model';
import { MobileSubscriptionType } from './data/mobile-plan-types';

export type UtilityPlanStatus = 'ACTIVE' | 'NO_ACTIVE' | 'SCHEDULED' | 'UNKNOWN';

export interface MobileActivitySummary {
  readonly status: UtilityPlanStatus;
  readonly activePlanCount: number;
  readonly callingCoverageActive: boolean;
  readonly callingCoverageEnd?: string;
  readonly daysUntilCallingEnd: number | null;
  readonly daysWithoutCalling: number | null;
  readonly dataActive: boolean;
  readonly scheduledVoiceStart?: string;
  readonly daysSinceLastExpiredPlan: number | null;
}

export interface LpgUsageSummary {
  readonly currentUsageDays: number | null;
  readonly estimatedDaysToCheck: number | null;
  readonly estimatedCheckDate?: string;
  readonly completedCylinderDurations: readonly number[];
  readonly emptyToReplacementDays: readonly number[];
  readonly refillsThisYear: number;
  readonly amountPaidThisYearMinor: number;
  readonly averageCompletedDuration: number | null;
  readonly currentCylinderStarted?: string;
  readonly currentCylinderEmpty: boolean;
}

export interface UtilityOverview {
  readonly mobileProfiles: number;
  readonly activeRechargeProfiles: number;
  readonly noActiveCallingProfiles: number;
  readonly expiringPlans: number;
  readonly expiringVoicePlans: number;
  readonly lpgConnections: number;
  readonly lpgChecksApproaching: number;
}

export function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function addCalendarDays(value: string, days: number): string {
  if (!validCalendarDate(value) || !Number.isSafeInteger(days))
    throw new Error('Enter a valid calendar date.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function calendarDaysBetween(from: string, to: string): number {
  if (!validCalendarDate(from) || !validCalendarDate(to))
    throw new Error('Enter valid calendar dates.');
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
  const [toYear, toMonth, toDay] = to.split('-').map(Number);
  return Math.round(
    (Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) /
      86_400_000,
  );
}

function hasVoice(plan: MobileRecharge): boolean {
  return plan.planType !== 'DATA_ONLY';
}

function hasData(plan: MobileRecharge): boolean {
  return plan.planType !== 'VOICE_ONLY';
}

function voiceCoverageEnd(plans: readonly MobileRecharge[], today: string): string | undefined {
  const intervals = plans
    .filter((plan) => hasVoice(plan) && plan.endDate >= today)
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
  if (!intervals.length) return undefined;
  let end = intervals[0].endDate;
  for (const plan of intervals.slice(1)) {
    if (plan.startDate > addCalendarDays(end, 1)) break;
    if (plan.endDate > end) end = plan.endDate;
  }
  return end;
}

export function mobileActivitySummary(
  plans: readonly MobileRecharge[],
  subscriptionType: MobileSubscriptionType,
  today = indiaTodayIso(),
): MobileActivitySummary {
  const validPlans = plans.filter(
    (plan) => validCalendarDate(plan.startDate) && validCalendarDate(plan.endDate),
  );
  const active = validPlans.filter((plan) => plan.startDate <= today && today <= plan.endDate);
  const future = validPlans.filter((plan) => plan.startDate > today);
  const activeVoice = active.some(hasVoice);
  const dataActive = active.some(hasData);
  const end = activeVoice ? voiceCoverageEnd(validPlans, today) : undefined;
  const daysUntilCallingEnd = end ? calendarDaysBetween(today, end) : null;
  const latestExpiredVoice = validPlans
    .filter((plan) => hasVoice(plan) && plan.endDate < today)
    .map((plan) => plan.endDate)
    .sort()
    .at(-1);
  const daysWithoutCalling =
    subscriptionType === 'PREPAID' && !activeVoice && latestExpiredVoice
      ? calendarDaysBetween(latestExpiredVoice, today)
      : null;
  const latestExpiredPlan = validPlans
    .filter((plan) => plan.endDate < today)
    .map((plan) => plan.endDate)
    .sort()
    .at(-1);
  const scheduledVoiceStart = future
    .filter(hasVoice)
    .map((plan) => plan.startDate)
    .sort()[0];
  const status: UtilityPlanStatus = active.length
    ? 'ACTIVE'
    : future.length
      ? 'SCHEDULED'
      : subscriptionType === 'POSTPAID'
        ? 'UNKNOWN'
        : validPlans.length
          ? 'NO_ACTIVE'
          : 'UNKNOWN';

  return {
    status,
    activePlanCount: active.length,
    callingCoverageActive: activeVoice,
    callingCoverageEnd: end,
    daysUntilCallingEnd,
    daysWithoutCalling,
    dataActive,
    scheduledVoiceStart,
    daysSinceLastExpiredPlan: latestExpiredPlan
      ? calendarDaysBetween(latestExpiredPlan, today)
      : null,
  };
}

export function suggestedVoicePlanStart(
  plans: readonly MobileRecharge[],
  today = indiaTodayIso(),
): string {
  const currentOrFutureVoice = plans.filter((plan) => hasVoice(plan) && plan.endDate >= today);
  if (!currentOrFutureVoice.length) return today;
  const first = currentOrFutureVoice
    .slice()
    .sort((left, right) => left.startDate.localeCompare(right.startDate))[0];
  let end = first.endDate;
  const remaining = currentOrFutureVoice
    .filter((plan) => plan !== first)
    .slice()
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
  for (const plan of remaining) {
    if (plan.startDate > addCalendarDays(end, 1)) break;
    if (plan.endDate > end) end = plan.endDate;
  }
  return addCalendarDays(end, 1);
}

function currentCylinderState(events: readonly LpgEvent[]): {
  start?: LpgEvent;
  empty: boolean;
} {
  const sorted = events
    .slice()
    .sort((left, right) =>
      left.eventDate === right.eventDate
        ? left.createdAt.localeCompare(right.createdAt)
        : left.eventDate.localeCompare(right.eventDate),
    );
  let current: LpgEvent | undefined;
  let empty = false;
  for (const event of sorted) {
    if (event.eventType === 'STARTED') {
      current = event;
      empty = false;
    }
    if (event.eventType === 'EMPTY') {
      current = undefined;
      empty = true;
    }
  }
  return { start: current, empty };
}

export function lpgUsageSummary(
  events: readonly LpgEvent[],
  estimatedUsageDays = 25,
  today = indiaTodayIso(),
): LpgUsageSummary {
  const sorted = events
    .filter((event) => validCalendarDate(event.eventDate))
    .slice()
    .sort((left, right) =>
      left.eventDate === right.eventDate
        ? left.createdAt.localeCompare(right.createdAt)
        : left.eventDate.localeCompare(right.eventDate),
    );
  const completedCylinderDurations: number[] = [];
  const emptyToReplacementDays: number[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index];
    if (event.eventType !== 'EMPTY') continue;
    const previousEvents = sorted.slice(0, index);
    const previousEmpty = previousEvents.reduce(
      (lastIndex, item, itemIndex) => (item.eventType === 'EMPTY' ? itemIndex : lastIndex),
      -1,
    );
    const previousStart = previousEvents
      .slice(previousEmpty + 1)
      .filter((item) => item.eventType === 'STARTED')
      .at(-1);
    if (previousStart)
      completedCylinderDurations.push(
        Math.max(1, calendarDaysBetween(previousStart.eventDate, event.eventDate) + 1),
      );
    const replacement = sorted
      .slice(index + 1)
      .find((item) => item.eventType === 'REFILL_RECEIVED');
    if (replacement)
      emptyToReplacementDays.push(calendarDaysBetween(event.eventDate, replacement.eventDate));
  }
  const cylinder = currentCylinderState(sorted.filter((event) => event.eventDate <= today));
  const currentStart = cylinder.start;
  const currentCylinderEmpty = cylinder.empty;
  const checkDate = currentStart
    ? addCalendarDays(currentStart.eventDate, Math.max(0, estimatedUsageDays - 1))
    : undefined;
  const estimatedDaysToCheck = checkDate ? calendarDaysBetween(today, checkDate) : null;
  const year = Number(today.slice(0, 4));
  const yearEvents = sorted.filter(
    (event) =>
      event.eventType === 'REFILL_RECEIVED' && Number(event.eventDate.slice(0, 4)) === year,
  );
  const average = completedCylinderDurations.length
    ? Math.round(
        completedCylinderDurations.reduce((sum, days) => sum + days, 0) /
          completedCylinderDurations.length,
      )
    : null;
  return {
    currentUsageDays: currentStart
      ? Math.max(1, calendarDaysBetween(currentStart.eventDate, today) + 1)
      : null,
    estimatedDaysToCheck,
    estimatedCheckDate: checkDate,
    completedCylinderDurations,
    emptyToReplacementDays,
    refillsThisYear: yearEvents.length,
    amountPaidThisYearMinor: yearEvents.reduce((sum, event) => sum + (event.amountMinor ?? 0), 0),
    averageCompletedDuration: average,
    currentCylinderStarted: currentStart?.eventDate,
    currentCylinderEmpty,
  };
}

export function utilityOverview(
  mobiles: readonly {
    profile: { archived: boolean; subscriptionType: MobileSubscriptionType };
    plans: readonly MobileRecharge[];
  }[],
  lpg: readonly {
    profile: { archived: boolean };
    events: readonly LpgEvent[];
    estimatedUsageDays: number;
  }[],
  today = indiaTodayIso(),
): UtilityOverview {
  const activeMobiles = mobiles.filter(({ profile }) => !profile.archived);
  const activeLpg = lpg.filter(({ profile }) => !profile.archived);
  const mobileSummaries = activeMobiles.map(({ profile, plans }) =>
    mobileActivitySummary(plans, profile.subscriptionType, today),
  );
  const expiringPlans = activeMobiles.filter(({ profile, plans }) => {
    const voiceEnd = mobileActivitySummary(
      plans,
      profile.subscriptionType,
      today,
    ).callingCoverageEnd;
    return plans.some((plan) => {
      const remaining = calendarDaysBetween(today, plan.endDate);
      const voicePlan = plan.planType !== 'DATA_ONLY';
      return remaining >= 0 && remaining <= 10 && (!voicePlan || plan.endDate === voiceEnd);
    });
  }).length;
  return {
    mobileProfiles: activeMobiles.length,
    activeRechargeProfiles: mobileSummaries.filter((summary) => summary.activePlanCount > 0).length,
    noActiveCallingProfiles: activeMobiles.filter(
      ({ profile }, index) =>
        profile.subscriptionType === 'PREPAID' && !mobileSummaries[index].callingCoverageActive,
    ).length,
    expiringPlans,
    expiringVoicePlans: activeMobiles.filter(
      ({ profile }, index) =>
        profile.subscriptionType === 'PREPAID' &&
        mobileSummaries[index].callingCoverageActive &&
        mobileSummaries[index].daysUntilCallingEnd !== null &&
        mobileSummaries[index].daysUntilCallingEnd <= 10,
    ).length,
    lpgConnections: activeLpg.length,
    lpgChecksApproaching: activeLpg.filter(({ events, estimatedUsageDays }) => {
      const summary = lpgUsageSummary(events, estimatedUsageDays, today);
      return (
        summary.estimatedDaysToCheck !== null &&
        summary.estimatedDaysToCheck <= 3 &&
        !summary.currentCylinderEmpty
      );
    }).length,
  };
}
