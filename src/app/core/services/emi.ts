import { EmiInstallment, EmiPlan, Money } from '../models/domain';
import { paymentDueDate, statementDateFor, toIsoDate } from './billing-cycle';

export function monthlyEmi(
  principalMinor: Money,
  annualRateBasisPoints: number,
  months: number,
): Money {
  if (months <= 0) throw new Error('Tenure must be greater than zero.');
  if (annualRateBasisPoints === 0) return Math.round(principalMinor / months);
  const monthlyRate = annualRateBasisPoints / 10_000 / 12;
  const growth = (1 + monthlyRate) ** months;
  return Math.round((principalMinor * monthlyRate * growth) / (growth - 1));
}

export function createEmiSchedule(
  plan: EmiPlan,
  card: {
    statementDay: number;
    dueDateMode: 'FIXED_DAY' | 'DAYS_AFTER_STATEMENT';
    paymentDueDay?: number;
    daysAfterStatement?: number;
    adjustDueDateOnWeekend: boolean;
  },
): readonly EmiInstallment[] {
  const installmentMinor = monthlyEmi(
    plan.convertedAmountMinor,
    plan.annualRateBasisPoints,
    plan.tenureMonths,
  );
  const monthlyRate = plan.annualRateBasisPoints / 10_000 / 12;
  let remaining = plan.convertedAmountMinor;
  const firstStatement = statementDateFor(
    new Date(`${plan.startDate}T00:00:00`),
    card.statementDay,
  );
  return Array.from({ length: plan.tenureMonths }, (_, index) => {
    const statement = new Date(
      firstStatement.getFullYear(),
      firstStatement.getMonth() + index,
      card.statementDay,
    );
    const interest = Math.round(remaining * monthlyRate);
    const principal =
      index === plan.tenureMonths - 1
        ? remaining
        : Math.min(remaining, installmentMinor - interest);
    remaining -= principal;
    return {
      installmentNumber: index + 1,
      statementDate: toIsoDate(statement),
      dueDate: toIsoDate(paymentDueDate(statement, card)),
      principalMinor: principal,
      interestMinor: interest,
      totalMinor: principal + interest,
      remainingPrincipalMinor: remaining,
      paid: false,
    };
  });
}
