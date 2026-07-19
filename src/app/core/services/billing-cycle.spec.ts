import {
  daysBetween,
  gracePeriodEndDate,
  gracePeriodBreakdown,
  normalizeCardDueDateRule,
  paymentDueDate,
  statementPeriod,
  toIsoDate,
} from './billing-cycle';
import { CreditCard } from '../models/domain';

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

  it('uses a later fixed due day in the statement month', () => {
    const due = paymentDueDate(new Date(2026, 6, 1), {
      dueDateMode: 'FIXED_DAY',
      paymentDueDay: 20,
      adjustDueDateOnWeekend: false,
    });
    expect(toIsoDate(due)).toBe('2026-07-20');
  });

  it('uses the next month when the fixed due day precedes the statement day', () => {
    const due = paymentDueDate(new Date(2026, 6, 25), {
      dueDateMode: 'FIXED_DAY',
      paymentDueDay: 3,
      adjustDueDateOnWeekend: false,
    });
    expect(toIsoDate(due)).toBe('2026-08-03');
  });

  it('does not move a fixed calendar due day that falls on a weekend', () => {
    const due = paymentDueDate(new Date(2026, 7, 1), {
      dueDateMode: 'FIXED_DAY',
      paymentDueDay: 2,
      adjustDueDateOnWeekend: true,
    });
    expect(toIsoDate(due)).toBe('2026-08-02');
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

  it('combines days until the next statement with the issuer payment window', () => {
    const grace = gracePeriodBreakdown(
      {
        statementDay: 25,
        dueDateMode: 'DAYS_AFTER_STATEMENT',
        daysAfterStatement: 20,
        adjustDueDateOnWeekend: false,
      },
      new Date(2026, 6, 1),
    );
    expect(grace).toEqual({ statementDays: 24, paymentDays: 20, totalDays: 44 });
    expect(
      toIsoDate(
        gracePeriodEndDate(
          {
            statementDay: 25,
            dueDateMode: 'DAYS_AFTER_STATEMENT',
            daysAfterStatement: 20,
            adjustDueDateOnWeekend: false,
          },
          new Date(2026, 6, 1),
        ),
      ),
    ).toBe('2026-08-14');
  });

  it('normalizes an old fixed calendar due date to days after statement', () => {
    const card = {
      statementDay: 1,
      dueDateMode: 'FIXED_DAY',
      paymentDueDay: 20,
      adjustDueDateOnWeekend: false,
    } as CreditCard;
    const normalized = normalizeCardDueDateRule(card, new Date(2026, 6, 1));
    expect(normalized.dueDateMode).toBe('DAYS_AFTER_STATEMENT');
    expect(normalized.daysAfterStatement).toBe(19);
    expect(normalized.paymentDueDay).toBeUndefined();
  });
});
