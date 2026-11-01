import { DatabaseSession } from '../data/sqlite-database';
import { CardTransaction, PaymentGroup } from '../models/domain';

export function eligiblePaymentMember(item: CardTransaction): boolean {
  return (
    Number.isSafeInteger(item.amountMinor) &&
    item.amountMinor > 0 &&
    (item.type === 'PURCHASE' ||
      (item.type === 'ADJUSTMENT' &&
        item.adjustmentDirection !== 'DECREASE' &&
        item.adjustmentPurpose !== 'BALANCE_RECONCILIATION'))
  );
}

export async function readPaymentGroups(
  tx: Pick<DatabaseSession, 'query'>,
): Promise<readonly PaymentGroup[]> {
  const groups = await tx.query<{
    id: string;
    kind: PaymentGroup['kind'];
    anchorId: string | null;
    title: string;
    currency: string;
    billTotalMinor: number | null;
    createdAt: string;
    updatedAt: string;
  }>(
    'SELECT id,kind,anchor_transaction_id AS anchorId,title,currency_code AS currency,bill_total_minor AS billTotalMinor,created_at AS createdAt,updated_at AS updatedAt FROM transaction_split_groups',
  );
  const members = await tx.query<{ group_id: string; transaction_id: string }>(
    'SELECT group_id,transaction_id FROM transaction_split_members ORDER BY rowid',
  );
  return groups.map((group) => ({
    ...group,
    memberIds: members.filter((row) => row.group_id === group.id).map((row) => row.transaction_id),
  }));
}

async function writeMembership(
  tx: DatabaseSession,
  item: CardTransaction,
  groupId: string | undefined,
): Promise<void> {
  const next = {
    ...item,
    splitGroupId: groupId,
    ...(!groupId && item.adjustmentPurpose === 'SPLIT_PAYMENT'
      ? { relatedTransactionId: undefined }
      : {}),
  };
  if (!groupId && item.adjustmentPurpose === 'SPLIT_PAYMENT')
    await tx.run('DELETE FROM transaction_links WHERE transaction_id=?', [item.id]);
  await tx.run('UPDATE card_transactions SET payload=? WHERE id=?', [
    JSON.stringify(next),
    item.id,
  ]);
}

export interface PaymentGroupEdits {
  title?: string;
  billTotalMinor?: number | null;
}

/** Call inside the same atomic operation that creates a real payment. No balances are touched. */
export async function attachPaymentGroup(
  tx: DatabaseSession,
  memberIds: readonly string[],
  targetId: string,
  edits: PaymentGroupEdits = {},
): Promise<string> {
  if (new Set(memberIds).size !== memberIds.length) throw new Error('Duplicate payment members.');
  const ledger = (await tx.query<{ payload: string }>('SELECT payload FROM card_transactions')).map(
    (row) => JSON.parse(row.payload) as CardTransaction,
  );
  const groups = await readPaymentGroups(tx);
  const group = groups.find((row) => row.id === targetId || row.memberIds.includes(targetId));
  const anchor = ledger.find((item) => item.id === (group?.anchorId ?? targetId));
  if (!anchor || !eligiblePaymentMember(anchor) || (!group && anchor.type !== 'PURCHASE'))
    throw new Error('Choose an existing purchase or payment group.');
  const ids = [...new Set([...(group?.memberIds ?? [anchor.id]), ...memberIds])];
  if (ids.length < 2) throw new Error('A payment group needs at least two distinct payments.');
  const entries = ids.map((id) => {
    const item = ledger.find((row) => row.id === id);
    if (!item || !eligiblePaymentMember(item))
      throw new Error('Only positive purchase payments can be grouped.');
    if (item.currencyCode !== anchor.currencyCode)
      throw new Error('Payment currencies must match.');
    if (groups.some((row) => row.id !== group?.id && row.memberIds.includes(id)))
      throw new Error(
        'A payment already belongs to another group. Remove it from that group first.',
      );
    if (item.relatedTransactionId === item.id) throw new Error('A payment cannot link to itself.');
    const seen = new Set<string>([item.id]);
    let related = item.relatedTransactionId;
    while (related) {
      if (seen.has(related)) throw new Error('Cyclic purchase relationships are not allowed.');
      seen.add(related);
      related = ledger.find((row) => row.id === related)?.relatedTransactionId;
    }
    return item;
  });
  const bill =
    edits.billTotalMinor === undefined ? (group?.billTotalMinor ?? null) : edits.billTotalMinor;
  if (bill !== null && (!Number.isSafeInteger(bill) || bill < 0))
    throw new Error('Enter a valid bill total.');
  const total = entries.reduce((sum, item) => sum + item.amountMinor, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Combined payment total is too large.');
  const id = group?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const kind =
    group?.kind === 'DIVISION' && memberIds.every((member) => group.memberIds.includes(member))
      ? 'DIVISION'
      : 'PAYMENTS';
  await tx.run(
    `INSERT INTO transaction_split_groups(id,original_amount_minor,created_at,kind,anchor_transaction_id,title,currency_code,bill_total_minor,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,bill_total_minor=excluded.bill_total_minor,updated_at=excluded.updated_at`,
    [
      id,
      total,
      now,
      kind,
      anchor.id,
      (edits.title ?? group?.title ?? anchor.merchant ?? '').trim().slice(0, 150),
      anchor.currencyCode,
      bill,
      now,
    ],
  );
  for (const item of entries) {
    await tx.run(
      'INSERT INTO transaction_split_members(group_id,transaction_id) VALUES(?,?) ON CONFLICT(transaction_id) DO NOTHING',
      [id, item.id],
    );
    await writeMembership(tx, item, id);
  }
  return id;
}

/** Unlink/dissolve changes relationships only. Real payment entries remain untouched financially. */
export async function detachPaymentGroup(
  tx: DatabaseSession,
  transactionId: string,
  dissolve = false,
): Promise<void> {
  const group = (await readPaymentGroups(tx)).find(
    (row) => row.id === transactionId || row.memberIds.includes(transactionId),
  );
  if (!group) return;
  const ledger = (await tx.query<{ payload: string }>('SELECT payload FROM card_transactions')).map(
    (row) => JSON.parse(row.payload) as CardTransaction,
  );
  const remaining = group.memberIds.filter((id) => id !== transactionId);
  const clear = dissolve || remaining.length < 2;
  const removed = clear ? group.memberIds : [transactionId];
  for (const id of removed) {
    const item = ledger.find((row) => row.id === id);
    if (item) await writeMembership(tx, item, undefined);
    await tx.run('DELETE FROM transaction_split_members WHERE transaction_id=?', [id]);
  }
  if (clear) await tx.run('DELETE FROM transaction_split_groups WHERE id=?', [group.id]);
  else {
    const anchorId =
      group.anchorId === transactionId
        ? (remaining.find((id) =>
            ledger.some((item) => item.id === id && item.type === 'PURCHASE'),
          ) ?? remaining[0])
        : group.anchorId;
    if (group.anchorId === transactionId) {
      for (const id of remaining) {
        const item = ledger.find((row) => row.id === id);
        if (item?.adjustmentPurpose === 'SPLIT_PAYMENT') {
          const relatedTransactionId = id === anchorId ? undefined : (anchorId ?? undefined);
          await tx.run('UPDATE card_transactions SET payload=? WHERE id=?', [
            JSON.stringify({ ...item, relatedTransactionId }),
            id,
          ]);
          await tx.run('DELETE FROM transaction_links WHERE transaction_id=?', [id]);
          if (relatedTransactionId)
            await tx.run(
              "INSERT INTO transaction_links(transaction_id,related_transaction_id,relationship_type,created_at) VALUES(?,?,'ADJUSTMENT',?)",
              [id, relatedTransactionId, item.createdAt],
            );
        }
      }
    }
    await tx.run(
      'UPDATE transaction_split_groups SET anchor_transaction_id=?,updated_at=? WHERE id=?',
      [anchorId, new Date().toISOString(), group.id],
    );
  }
}
