import { BankActivityEvent, bankActivitySummary } from './bank-activity-model';

describe('Bank Activity inactivity labels', () => {
  it('uses the last valid event date with six- and twelve-calendar-month thresholds', () => {
    const event = (activityDate: string): BankActivityEvent => ({
      id: activityDate,
      profileId: 'fiction-profile',
      activityDate,
      direction: 'DEBIT',
      origin: 'MANUAL',
      verification: 'USER_CONFIRMED',
      createdAt: `${activityDate}T10:00:00Z`,
      updatedAt: `${activityDate}T10:00:00Z`,
    });
    expect(bankActivitySummary([event('2026-04-25')], '2026-10-24')).toMatchObject({
      status: 'RECENTLY_USED',
      calendarMonths: 5,
      daysSinceActivity: 182,
    });
    expect(bankActivitySummary([event('2026-04-24')], '2026-10-24')).toMatchObject({
      status: 'NOT_USED_RECENTLY',
      calendarMonths: 6,
    });
    expect(bankActivitySummary([event('2025-10-24')], '2026-10-24')).toMatchObject({
      status: 'LONG_INACTIVE',
      calendarMonths: 12,
    });
  });

  it('ignores future-only history and describes accounts without known activity as unknown', () => {
    expect(bankActivitySummary([], '2026-10-24')).toMatchObject({
      status: 'UNKNOWN',
      daysSinceActivity: null,
    });
    const summary = bankActivitySummary(
      [
        {
          id: 'future',
          profileId: 'fiction-profile',
          activityDate: '2026-10-25',
          direction: 'CREDIT',
          origin: 'MANUAL',
          verification: 'USER_CONFIRMED',
          createdAt: '2026-10-25T10:00:00Z',
          updatedAt: '2026-10-25T10:00:00Z',
        },
      ],
      '2026-10-24',
    );
    expect(summary).toMatchObject({
      status: 'UNKNOWN',
    });
    expect(summary.lastActivityDate).toBeUndefined();
  });
});
