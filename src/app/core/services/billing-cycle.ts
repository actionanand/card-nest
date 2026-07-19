import { CreditCard } from '../models/domain';

function localDate(year: number, month: number, day: number): Date {
  return new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate()));
}

export function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function statementDateFor(reference: Date, statementDay: number): Date {
  const thisMonth = localDate(reference.getFullYear(), reference.getMonth(), statementDay);
  return reference <= thisMonth
    ? thisMonth
    : localDate(reference.getFullYear(), reference.getMonth() + 1, statementDay);
}

export function previousStatementDate(statementDate: Date, statementDay: number): Date {
  return localDate(statementDate.getFullYear(), statementDate.getMonth() - 1, statementDay);
}

export function statementPeriod(reference: Date, statementDay: number): { start: Date; end: Date } {
  const end = statementDateFor(reference, statementDay);
  const previous = previousStatementDate(end, statementDay);
  const start = new Date(previous);
  start.setDate(start.getDate() + 1);
  return { start, end };
}

export function paymentDueDate(
  statementDate: Date,
  card: Pick<
    CreditCard,
    'dueDateMode' | 'paymentDueDay' | 'daysAfterStatement' | 'adjustDueDateOnWeekend'
  >,
): Date {
  let due: Date;
  if (card.dueDateMode === 'DAYS_AFTER_STATEMENT') {
    due = new Date(statementDate);
    due.setDate(due.getDate() + (card.daysAfterStatement ?? 20));
  } else {
    const paymentDueDay = card.paymentDueDay ?? 1;
    const dueMonthOffset = paymentDueDay > statementDate.getDate() ? 0 : 1;
    due = localDate(
      statementDate.getFullYear(),
      statementDate.getMonth() + dueMonthOffset,
      paymentDueDay,
    );
  }
  if (card.dueDateMode === 'DAYS_AFTER_STATEMENT' && card.adjustDueDateOnWeekend) {
    if (due.getDay() === 6) due.setDate(due.getDate() + 2);
    if (due.getDay() === 0) due.setDate(due.getDate() + 1);
  }
  return due;
}

export function daysBetween(from: Date, to: Date): number {
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.ceil((end - start) / 86_400_000);
}

export function estimatedGracePeriod(
  card: Pick<
    CreditCard,
    | 'statementDay'
    | 'dueDateMode'
    | 'paymentDueDay'
    | 'daysAfterStatement'
    | 'adjustDueDateOnWeekend'
  >,
  reference = new Date(),
): number {
  const statement = statementDateFor(reference, card.statementDay);
  return daysBetween(statement, paymentDueDate(statement, card));
}
