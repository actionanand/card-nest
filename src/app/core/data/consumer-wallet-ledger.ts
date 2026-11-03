import { ConsumerWalletEvent, ConsumerWalletEventAllocation } from '../models/domain';
import { DatabaseSession } from './sqlite-database';

export type ConsumerWalletEventPosition = Pick<
  ConsumerWalletEvent,
  'id' | 'eventDate' | 'eventTime' | 'createdAt'
>;

export function compareConsumerWalletEvents(
  left: ConsumerWalletEventPosition,
  right: ConsumerWalletEventPosition,
): number {
  return (
    left.eventDate.localeCompare(right.eventDate) ||
    (left.eventTime ?? '').localeCompare(right.eventTime ?? '') ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

export type ExpenseReversalClassifier = (
  credit: ConsumerWalletEvent,
  allocatedMinor: number,
  alreadyConsumedMinor: number,
) => Promise<number>;

export interface ConsumerWalletDebitAllocationPlan {
  readonly creditEvent: ConsumerWalletEvent;
  readonly allocatedMinor: number;
  readonly expenseReversalMinor: number;
}

/** Calculates deterministic prior-credit FIFO without modifying the caller's session. */
export async function planConsumerWalletDebit(
  tx: DatabaseSession,
  debit: ConsumerWalletEvent,
  amountMinor: number,
  classifyExpenseReversal: ExpenseReversalClassifier = async () => 0,
): Promise<ConsumerWalletDebitAllocationPlan[]> {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
    throw new Error('Enter a valid wallet debit amount.');
  const creditRows = await tx.query<{ id: string; balance_delta_minor: number; payload: string }>(
    'SELECT id,balance_delta_minor,payload FROM consumer_wallet_events WHERE wallet_id=? AND balance_delta_minor>0 AND id<>?',
    [debit.walletId, debit.id],
  );
  const credits = creditRows
    .map((row) => ({
      id: row.id,
      amountMinor: row.balance_delta_minor,
      event: JSON.parse(row.payload) as ConsumerWalletEvent,
    }))
    .filter((credit) => compareConsumerWalletEvents(credit.event, debit) < 0)
    .sort((left, right) => compareConsumerWalletEvents(left.event, right.event));
  let remaining = amountMinor;
  const plan: ConsumerWalletDebitAllocationPlan[] = [];
  for (const credit of credits) {
    if (!remaining) break;
    const priorAllocations = await tx.query<{ allocated_minor: number; payload: string }>(
      `SELECT a.allocated_minor,e.payload
       FROM consumer_wallet_event_allocations a
       JOIN consumer_wallet_events e ON e.id=a.debit_event_id
       WHERE a.credit_event_id=?`,
      [credit.id],
    );
    const alreadyConsumed = priorAllocations.reduce((total, allocation) => {
      const priorDebit = JSON.parse(allocation.payload) as ConsumerWalletEvent;
      return compareConsumerWalletEvents(priorDebit, debit) < 0
        ? total + allocation.allocated_minor
        : total;
    }, 0);
    if (!Number.isSafeInteger(alreadyConsumed))
      throw new Error('Wallet credit allocation exceeds the supported balance range.');
    const available = credit.amountMinor - alreadyConsumed;
    if (available <= 0) continue;
    const allocatedMinor = Math.min(available, remaining);
    const expenseReversalMinor = await classifyExpenseReversal(
      credit.event,
      allocatedMinor,
      alreadyConsumed,
    );
    if (
      !Number.isSafeInteger(expenseReversalMinor) ||
      expenseReversalMinor < 0 ||
      expenseReversalMinor > allocatedMinor
    )
      throw new Error('Wallet expense reversal exceeds its funded allocation.');
    plan.push({
      creditEvent: credit.event,
      allocatedMinor,
      expenseReversalMinor,
    });
    remaining -= allocatedMinor;
  }
  if (remaining)
    throw new Error('Wallet balance provenance is incomplete; the debit was not saved.');
  return plan;
}

/** Persists a debit's planned FIFO edges inside the caller's transaction. */
export async function allocateConsumerWalletDebit(
  tx: DatabaseSession,
  debit: ConsumerWalletEvent,
  amountMinor: number,
  classifyExpenseReversal: ExpenseReversalClassifier = async () => 0,
): Promise<ConsumerWalletEventAllocation[]> {
  const plan = await planConsumerWalletDebit(tx, debit, amountMinor, classifyExpenseReversal);
  return persistConsumerWalletDebitPlan(tx, debit, plan);
}

export async function persistConsumerWalletDebitPlan(
  tx: DatabaseSession,
  debit: ConsumerWalletEvent,
  plan: readonly ConsumerWalletDebitAllocationPlan[],
): Promise<ConsumerWalletEventAllocation[]> {
  const allocations: ConsumerWalletEventAllocation[] = [];
  for (const item of plan) {
    const allocation: ConsumerWalletEventAllocation = {
      id: crypto.randomUUID(),
      debitEventId: debit.id,
      creditEventId: item.creditEvent.id,
      allocatedMinor: item.allocatedMinor,
      expenseReversalMinor: item.expenseReversalMinor,
      createdAt: new Date().toISOString(),
    };
    await tx.run(
      'INSERT INTO consumer_wallet_event_allocations(id,debit_event_id,credit_event_id,allocated_minor,expense_reversal_minor,created_at) VALUES(?,?,?,?,?,?)',
      [
        allocation.id,
        allocation.debitEventId,
        allocation.creditEventId,
        allocation.allocatedMinor,
        allocation.expenseReversalMinor,
        allocation.createdAt,
      ],
    );
    allocations.push(allocation);
  }
  return allocations;
}

/** Validates balances and immutable FIFO provenance inside the caller's SQLite transaction. */
export async function assertChronologicalConsumerWalletLedger(
  tx: DatabaseSession,
  walletId: string,
  preview?: {
    readonly additionalEvents?: readonly ConsumerWalletEvent[];
    readonly additionalAllocations?: readonly ConsumerWalletEventAllocation[];
  },
): Promise<void> {
  const rows = await tx.query<{ payload: string }>(
    'SELECT payload FROM consumer_wallet_events WHERE wallet_id=?',
    [walletId],
  );
  const events = rows
    .map((row) => JSON.parse(row.payload) as ConsumerWalletEvent)
    .concat((preview?.additionalEvents ?? []).filter((event) => event.walletId === walletId))
    .sort(compareConsumerWalletEvents);
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const allocationRows = await tx.query<{
    debit_event_id: string;
    credit_event_id: string;
    allocated_minor: number;
    expense_reversal_minor: number;
  }>(
    `SELECT debit_event_id,credit_event_id,allocated_minor,expense_reversal_minor
     FROM consumer_wallet_event_allocations
     WHERE debit_event_id IN (SELECT id FROM consumer_wallet_events WHERE wallet_id=?)
        OR credit_event_id IN (SELECT id FROM consumer_wallet_events WHERE wallet_id=?)`,
    [walletId, walletId],
  );
  const actualByDebit = new Map<string, Map<string, number>>();
  const allocatedByCredit = new Map<string, number>();
  let creditOverallocated = false;
  for (const allocation of [
    ...allocationRows,
    ...(preview?.additionalAllocations ?? []).map((allocation) => ({
      debit_event_id: allocation.debitEventId,
      credit_event_id: allocation.creditEventId,
      allocated_minor: allocation.allocatedMinor,
      expense_reversal_minor: allocation.expenseReversalMinor,
    })),
  ]) {
    const debit = eventsById.get(allocation.debit_event_id);
    const credit = eventsById.get(allocation.credit_event_id);
    if (!debit || !credit || debit.walletId !== walletId || credit.walletId !== walletId)
      throw new Error('Wallet allocation crosses wallet boundaries.');
    if (
      !Number.isSafeInteger(allocation.allocated_minor) ||
      allocation.allocated_minor <= 0 ||
      !Number.isSafeInteger(allocation.expense_reversal_minor) ||
      allocation.expense_reversal_minor < 0 ||
      allocation.expense_reversal_minor > allocation.allocated_minor
    )
      throw new Error('Wallet allocation contains an invalid amount.');
    if (compareConsumerWalletEvents(credit, debit) >= 0)
      throw new Error('Wallet debit allocates a future-dated credit.');
    const creditMap = actualByDebit.get(debit.id) ?? new Map<string, number>();
    creditMap.set(credit.id, (creditMap.get(credit.id) ?? 0) + allocation.allocated_minor);
    actualByDebit.set(debit.id, creditMap);
    const allocated = (allocatedByCredit.get(credit.id) ?? 0) + allocation.allocated_minor;
    if (!Number.isSafeInteger(allocated) || allocated > credit.balanceDeltaMinor)
      creditOverallocated = true;
    allocatedByCredit.set(credit.id, allocated);
  }

  let balance = 0;
  const lots: { id: string; available: number }[] = [];
  for (const event of events) {
    if (
      !Number.isSafeInteger(event.amountMinor) ||
      event.amountMinor <= 0 ||
      !Number.isSafeInteger(event.balanceDeltaMinor) ||
      event.balanceDeltaMinor === 0
    )
      throw new Error('Wallet history contains an invalid event amount.');
    const nextBalance = balance + event.balanceDeltaMinor;
    if (!Number.isSafeInteger(nextBalance))
      throw new Error('Wallet history exceeds the supported balance range.');
    if (nextBalance < 0)
      throw new Error('Wallet event would create a negative historical balance.');
    balance = nextBalance;

    if (event.balanceDeltaMinor > 0) {
      if (event.amountMinor !== event.balanceDeltaMinor)
        throw new Error('Wallet credit amount does not match its balance change.');
      lots.push({ id: event.id, available: event.balanceDeltaMinor });
      continue;
    }
    if (event.amountMinor !== Math.abs(event.balanceDeltaMinor))
      throw new Error('Wallet debit amount does not match its balance change.');

    let remaining = Math.abs(event.balanceDeltaMinor);
    const expected = new Map<string, number>();
    for (const lot of lots) {
      if (!remaining) break;
      const allocatedMinor = Math.min(lot.available, remaining);
      if (!allocatedMinor) continue;
      expected.set(lot.id, allocatedMinor);
      lot.available -= allocatedMinor;
      remaining -= allocatedMinor;
    }
    if (remaining) throw new Error('Wallet event exceeds historical credit provenance.');

    const actual = actualByDebit.get(event.id) ?? new Map<string, number>();
    if (
      expected.size !== actual.size ||
      [...expected].some(([creditId, amount]) => actual.get(creditId) !== amount)
    )
      throw new Error(
        'Wallet event would change audited FIFO allocations. Correct the history without rewriting prior events.',
      );
  }
  if (creditOverallocated) throw new Error('Wallet credit is over-allocated.');
}
