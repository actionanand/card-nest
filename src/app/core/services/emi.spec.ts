import { EmiPlan } from '../models/domain';
import { createEmiSchedule, monthlyEmi } from './emi';

describe('EMI calculations', () => {
  it('splits a no-cost EMI without losing minor units', () => {
    const plan: EmiPlan = {
      id: 'emi',
      transactionId: 'tx',
      cardId: 'card',
      convertedAmountMinor: 10000,
      remainingPurchaseMinor: 0,
      tenureMonths: 3,
      annualRateBasisPoints: 0,
      interestType: 'NO_COST',
      processingFeeMinor: 0,
      taxMinor: 0,
      startDate: '2026-07-14',
      status: 'ACTIVE',
    };
    const schedule = createEmiSchedule(plan, {
      statementDay: 15,
      dueDateMode: 'DAYS_AFTER_STATEMENT',
      daysAfterStatement: 20,
      adjustDueDateOnWeekend: false,
    });
    expect(schedule.map((item) => item.principalMinor)).toEqual([3333, 3333, 3334]);
    expect(schedule.at(-1)?.remainingPrincipalMinor).toBe(0);
  });

  it('uses the reducing-balance formula for standard EMI', () => {
    expect(monthlyEmi(3000000, 1400, 12)).toBe(269361);
  });

  it('rejects invalid tenure', () => {
    expect(() => monthlyEmi(10000, 1000, 0)).toThrow();
  });
});
