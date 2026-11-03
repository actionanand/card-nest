import { ConsumerWalletEvent } from '../models/domain';
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

/** Validates balances and immutable FIFO provenance inside the caller's SQLite transaction. */
export async function assertChronologicalConsumerWalletLedger(
  tx: DatabaseSession,
  walletId: string,
): Promise<void> {
  const rows = await tx.query<{ payload: string }>(
    'SELECT payload FROM consumer_wallet_events WHERE wallet_id=?',
    [walletId],
  );
  const events = rows
    .map((row) => JSON.parse(row.payload) as ConsumerWalletEvent)
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
  for (const allocation of allocationRows) {
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
