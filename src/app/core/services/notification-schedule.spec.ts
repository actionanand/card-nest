import { describe, expect, it } from 'vitest';
import {
  catchUpReminderToday,
  normalizedReminderDays,
  paymentReminderOffsets,
} from './notification-schedule';

describe('notification scheduling', () => {
  it('creates a daily reminder from the selected lead day through the due date', () => {
    expect(paymentReminderOffsets(5)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(paymentReminderOffsets(3)).toEqual([3, 2, 1, 0]);
    expect(paymentReminderOffsets(0)).toEqual([0]);
  });

  it('uses five days when an unsupported preference is restored', () => {
    expect(normalizedReminderDays(Number.NaN)).toBe(5);
    expect(normalizedReminderDays(10)).toBe(5);
  });

  it('catches up every reminder whose scheduled calendar day is today', () => {
    const now = new Date(2026, 7, 30, 11, 45, 0);
    const axisReminder = catchUpReminderToday(new Date(2026, 7, 30), now);
    const indusIndReminder = catchUpReminderToday(new Date(2026, 7, 30), now);

    expect(axisReminder).toEqual(new Date(2026, 7, 30, 11, 46, 0));
    expect(indusIndReminder).toEqual(new Date(2026, 7, 30, 11, 46, 0));
  });

  it('keeps future reminders at 9:00 AM local time', () => {
    const now = new Date(2026, 7, 30, 8, 0, 0);
    expect(catchUpReminderToday(new Date(2026, 7, 30), now)).toEqual(
      new Date(2026, 7, 30, 9, 0, 0),
    );
  });
});
