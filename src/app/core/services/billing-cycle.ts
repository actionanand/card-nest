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

/** Whether transactions dated on the statement generation day start the next billing cycle. */
export function excludesStatementDayTransactions(
  card: Pick<CreditCard, 'excludeStatementDayTransactions'>,
): boolean {
  return card.excludeStatementDayTransactions !== false;
}

/** Whether an ISO transaction date belongs to the statement ending on the supplied date. */
export function isTransactionIncludedInStatement(
  transactionDate: string,
  statementDate: Date,
  card: Pick<CreditCard, 'excludeStatementDayTransactions'>,
): boolean {
  const statementIso = toIsoDate(statementDate);
  return excludesStatementDayTransactions(card)
    ? transactionDate < statementIso
    : transactionDate <= statementIso;
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

export interface GracePeriodBreakdown {
  readonly statementDays: number;
  readonly paymentDays: number;
  readonly totalDays: number;
}

/**
 * Returns the issuer's payment window for one statement. Fixed calendar due dates
 * are retained only as a compatibility path for cards restored from older backups.
 */
export function paymentWindowDays(
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
  if (card.dueDateMode === 'DAYS_AFTER_STATEMENT') {
    return Math.max(1, card.daysAfterStatement ?? 20);
  }
  const statement = statementDateFor(reference, card.statementDay);
  return Math.max(1, daysBetween(statement, paymentDueDate(statement, card)));
}

export function gracePeriodBreakdown(
  card: Pick<
    CreditCard,
    | 'statementDay'
    | 'dueDateMode'
    | 'paymentDueDay'
    | 'daysAfterStatement'
    | 'adjustDueDateOnWeekend'
  >,
  reference = new Date(),
): GracePeriodBreakdown {
  const statement = statementDateFor(reference, card.statementDay);
  const finalPaymentDate = paymentDueDate(statement, card);
  const statementDays = Math.max(0, daysBetween(reference, statement));
  const paymentDays = Math.max(1, daysBetween(statement, finalPaymentDate));
  return {
    statementDays,
    paymentDays,
    totalDays: Math.max(1, daysBetween(reference, finalPaymentDate)),
  };
}

/** Final date on which a purchase made today would ordinarily need to be paid. */
export function gracePeriodEndDate(
  card: Pick<
    CreditCard,
    | 'statementDay'
    | 'dueDateMode'
    | 'paymentDueDay'
    | 'daysAfterStatement'
    | 'adjustDueDateOnWeekend'
  >,
  reference = new Date(),
): Date {
  return paymentDueDate(statementDateFor(reference, card.statementDay), card);
}

/** Converts the legacy fixed calendar due-date rule to the current issuer window model. */
export function normalizeCardDueDateRule(card: CreditCard, reference = new Date()): CreditCard {
  const needsStatementBoundaryDefault = card.excludeStatementDayTransactions === undefined;
  if (card.dueDateMode === 'DAYS_AFTER_STATEMENT' && !needsStatementBoundaryDefault) return card;
  return {
    ...card,
    excludeStatementDayTransactions: card.excludeStatementDayTransactions ?? true,
    ...(card.dueDateMode === 'DAYS_AFTER_STATEMENT'
      ? {}
      : {
          dueDateMode: 'DAYS_AFTER_STATEMENT' as const,
          paymentDueDay: undefined,
          daysAfterStatement: paymentWindowDays(card, reference),
        }),
  };
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
  return gracePeriodBreakdown(card, reference).totalDays;
}
