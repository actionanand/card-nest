import { daysBetween, paymentDueDate, statementPeriod, toIsoDate } from './billing-cycle';

describe('billing cycle calculations', () => {
  it('clamps a statement day to the final day of February in a leap year', () => {
    const period = statementPeriod(new Date(2028, 1, 10), 31);
    expect(toIsoDate(period.end)).toBe('2028-02-29');
    expect(toIsoDate(period.start)).toBe('2028-02-01');
  });

  it('clamps fixed due days for short months', () => {
    const due = paymentDueDate(new Date(2026, 0, 31), {
      dueDateMode: 'FIXED_DAY',
      paymentDueDay: 31,
      adjustDueDateOnWeekend: false,
    });
    expect(toIsoDate(due)).toBe('2026-02-28');
  });

  it('moves weekend due dates to Monday when configured', () => {
    const due = paymentDueDate(new Date(2026, 6, 10), {
      dueDateMode: 'DAYS_AFTER_STATEMENT',
      daysAfterStatement: 1,
      adjustDueDateOnWeekend: true,
    });
    expect(toIsoDate(due)).toBe('2026-07-13');
  });

  it('uses calendar days without daylight-saving drift', () => {
    expect(daysBetween(new Date(2026, 0, 31), new Date(2026, 1, 2))).toBe(2);
  });
});
