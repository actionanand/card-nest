export const DEFAULT_REMINDER_DAYS_BEFORE = 5;
export const MAX_REMINDER_DAYS_BEFORE = 5;
export const REMINDER_HOUR = 9;

export function normalizedReminderDays(days: number): number {
  return Number.isInteger(days) && days >= 0 && days <= MAX_REMINDER_DAYS_BEFORE
    ? days
    : DEFAULT_REMINDER_DAYS_BEFORE;
}

export function paymentReminderOffsets(daysBefore: number): readonly number[] {
  const safeDays = normalizedReminderDays(daysBefore);
  return Array.from({ length: safeDays + 1 }, (_, index) => safeDays - index);
}

export function catchUpReminderToday(at: Date, now: Date): Date {
  const scheduled = new Date(at);
  scheduled.setHours(REMINDER_HOUR, 0, 0, 0);
  if (
    scheduled <= now &&
    scheduled.getFullYear() === now.getFullYear() &&
    scheduled.getMonth() === now.getMonth() &&
    scheduled.getDate() === now.getDate()
  ) {
    scheduled.setTime(now.getTime() + 60_000);
  }
  return scheduled;
}
