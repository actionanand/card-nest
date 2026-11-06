import { DatabaseSession } from '../data/sqlite-database';
import { CardTransaction, ConsumerWalletSplitMember, PaymentGroup } from '../models/domain';

export function eligiblePaymentMember(item: CardTransaction): boolean {
  return (
    Number.isSafeInteger(item.amountMinor) &&
    item.amountMinor > 0 &&
    item.paymentMethod !== 'WALLET_LOADING' &&
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
  const walletMembers = await tx.query<{
    group_id: string;
    wallet_event_id: string;
    member_kind: ConsumerWalletSplitMember['memberKind'];
    member_order: number;
    created_at: string;
  }>(
    'SELECT group_id,wallet_event_id,member_kind,member_order,created_at FROM consumer_wallet_split_members ORDER BY group_id,member_order,rowid',
  );
  return groups.map((group) => ({
    ...group,
    memberIds: members.filter((row) => row.group_id === group.id).map((row) => row.transaction_id),
    walletMembers: walletMembers
      .filter((row) => row.group_id === group.id)
      .map((row) => ({
        groupId: row.group_id,
        walletEventId: row.wallet_event_id,
        memberKind: row.member_kind,
        memberOrder: row.member_order,
        createdAt: row.created_at,
      })),
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

export async function linkWalletRefundToPaymentGroup(
  tx: DatabaseSession,
  purchaseEventId: string,
  refundEventId: string,
  createdAt: string,
): Promise<void> {
  const [purchaseMember] = await tx.query<{ group_id: string }>(
    "SELECT group_id FROM consumer_wallet_split_members WHERE wallet_event_id=? AND member_kind='WALLET_PURCHASE'",
    [purchaseEventId],
  );
  if (!purchaseMember) return;
  const [existingMember] = await tx.query<{ group_id: string }>(
    'SELECT group_id FROM consumer_wallet_split_members WHERE wallet_event_id=?',
    [refundEventId],
  );
  if (existingMember && existingMember.group_id !== purchaseMember.group_id)
    throw new Error('This wallet refund already belongs to another payment group.');
  const [order] = await tx.query<{ member_order: number | null }>(
    'SELECT MAX(member_order) AS member_order FROM consumer_wallet_split_members WHERE group_id=?',
    [purchaseMember.group_id],
  );
  await tx.run(
    "INSERT INTO consumer_wallet_split_members(group_id,wallet_event_id,member_kind,member_order,created_at) VALUES(?,?,'WALLET_REFUND',?,?) ON CONFLICT(wallet_event_id) DO NOTHING",
    [purchaseMember.group_id, refundEventId, Number(order?.member_order ?? 0) + 1, createdAt],
  );
  await tx.run('UPDATE transaction_split_groups SET updated_at=? WHERE id=?', [
    createdAt,
    purchaseMember.group_id,
  ]);
}

/** Call inside the same atomic operation that creates a real payment. No balances are touched. */
export async function attachPaymentGroup(
  tx: DatabaseSession,
  memberIds: readonly string[],
  targetId: string,
  edits: PaymentGroupEdits = {},
  walletEventIds: readonly string[] = [],
): Promise<string> {
  const targetKind = targetId.startsWith('WALLET:')
    ? 'WALLET'
    : targetId.startsWith('CARD:')
      ? 'CARD'
      : undefined;
  if (targetKind) targetId = targetId.slice(targetKind === 'WALLET' ? 7 : 5);
  if (new Set(memberIds).size !== memberIds.length) throw new Error('Duplicate payment members.');
  if (new Set(walletEventIds).size !== walletEventIds.length)
    throw new Error('Duplicate wallet payment members.');
  const ledger = (await tx.query<{ payload: string }>('SELECT payload FROM card_transactions')).map(
    (row) => JSON.parse(row.payload) as CardTransaction,
  );
  const groups = await readPaymentGroups(tx);
  const group = groups.find(
    (row) =>
      (!targetKind && row.id === targetId) ||
      (targetKind !== 'WALLET' && row.memberIds.includes(targetId)) ||
      (targetKind !== 'CARD' &&
        row.walletMembers.some((member) => member.walletEventId === targetId)),
  );
  const targetTransaction =
    targetKind === 'WALLET' ? undefined : ledger.find((item) => item.id === targetId);
  const [targetWalletEvent] =
    group || targetKind === 'CARD' || targetTransaction
      ? []
      : await tx.query<{ id: string; event_type: string }>(
          'SELECT id,event_type FROM consumer_wallet_events WHERE id=?',
          [targetId],
        );
  const anchor =
    targetKind === 'WALLET' && !group
      ? undefined
      : ledger.find((item) => item.id === (group?.anchorId ?? targetId));
  if (!group && !targetWalletEvent && (!anchor || !eligiblePaymentMember(anchor)))
    throw new Error('Choose an existing purchase or payment group.');
  if (!group && targetTransaction && targetTransaction.type !== 'PURCHASE')
    throw new Error('Start a payment group from a recorded purchase.');
  const ids = [
    ...new Set([...(group?.memberIds ?? (targetTransaction ? [targetId] : [])), ...memberIds]),
  ];
  const walletIds = [
    ...new Set([
      ...(group?.walletMembers.map((member) => member.walletEventId) ??
        (targetWalletEvent ? [targetId] : [])),
      ...walletEventIds,
    ]),
  ];
  if (ids.length + walletIds.length < 2)
    throw new Error('A payment group needs at least two distinct payments.');
  const entries = ids.map((id) => {
    const item = ledger.find((row) => row.id === id);
    if (!item || !eligiblePaymentMember(item))
      throw new Error('Only positive purchase payments can be grouped.');
    if (anchor && item.currencyCode !== anchor.currencyCode)
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
  const walletRows = await tx.query<{
    id: string;
    wallet_id: string;
    event_type: string;
    amount_minor: number;
    balance_delta_minor: number;
    reversal_of_event_id: string | null;
  }>(
    `SELECT id,wallet_id,event_type,amount_minor,balance_delta_minor,reversal_of_event_id
     FROM consumer_wallet_events WHERE id IN (${walletIds.map(() => '?').join(',') || "''"})`,
    walletIds,
  );
  if (walletRows.length !== walletIds.length)
    throw new Error('A selected wallet payment no longer exists.');
  const existingWalletMembers = new Map(
    (group?.walletMembers ?? []).map((member) => [member.walletEventId, member.memberKind]),
  );
  const walletPurchases: (typeof walletRows)[number][] = [];
  for (const event of walletRows) {
    const existingKind = existingWalletMembers.get(event.id);
    if (existingKind === 'WALLET_REFUND') {
      if (!['REFUND', 'REVERSAL'].includes(event.event_type) || !event.reversal_of_event_id)
        throw new Error('A wallet refund group member has invalid purchase provenance.');
      continue;
    }
    if (
      event.event_type !== 'PURCHASE' ||
      !Number.isSafeInteger(event.amount_minor) ||
      event.amount_minor <= 0 ||
      event.balance_delta_minor !== -event.amount_minor
    )
      throw new Error('Only completed wallet purchases can be grouped as payments.');
    const [membership] = await tx.query<{ group_id: string }>(
      'SELECT group_id FROM consumer_wallet_split_members WHERE wallet_event_id=?',
      [event.id],
    );
    if (membership && membership.group_id !== group?.id)
      throw new Error('A wallet payment already belongs to another group.');
    walletPurchases.push(event);
  }
  const primaryAnchor = anchor ?? entries[0];
  const currency = primaryAnchor?.currencyCode ?? 'INR';
  if (entries.some((entry) => entry.currencyCode !== currency))
    throw new Error('Payment currencies must match.');
  if (currency !== 'INR' && walletIds.length)
    throw new Error('Consumer wallet payments can only be grouped with INR payments.');
  const bill =
    edits.billTotalMinor === undefined ? (group?.billTotalMinor ?? null) : edits.billTotalMinor;
  if (bill !== null && (!Number.isSafeInteger(bill) || bill < 0))
    throw new Error('Enter a valid bill total.');
  const total =
    entries.reduce((sum, item) => sum + item.amountMinor, 0) +
    walletPurchases.reduce((sum, item) => sum + item.amount_minor, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Combined payment total is too large.');
  const id = group?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const kind =
    group?.kind === 'DIVISION' &&
    memberIds.every((member) => group.memberIds.includes(member)) &&
    walletEventIds.every((member) =>
      group.walletMembers.some((row) => row.walletEventId === member),
    )
      ? 'DIVISION'
      : 'PAYMENTS';
  await tx.run(
    `INSERT INTO transaction_split_groups(id,original_amount_minor,created_at,kind,anchor_transaction_id,title,currency_code,bill_total_minor,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET original_amount_minor=excluded.original_amount_minor,kind=excluded.kind,anchor_transaction_id=excluded.anchor_transaction_id,title=excluded.title,currency_code=excluded.currency_code,bill_total_minor=excluded.bill_total_minor,updated_at=excluded.updated_at`,
    [
      id,
      total,
      now,
      kind,
      primaryAnchor?.id ?? null,
      (edits.title ?? group?.title ?? primaryAnchor?.merchant ?? '').trim().slice(0, 150),
      currency,
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
  let memberOrder = Math.max(
    0,
    ...(group?.walletMembers.map((member) => member.memberOrder) ?? []),
  );
  for (const event of walletPurchases) {
    await tx.run(
      'INSERT INTO consumer_wallet_split_members(group_id,wallet_event_id,member_kind,member_order,created_at) VALUES(?,?,?,?,?) ON CONFLICT(wallet_event_id) DO NOTHING',
      [id, event.id, 'WALLET_PURCHASE', ++memberOrder, now],
    );
    const refunds = await tx.query<{
      id: string;
      event_type: string;
      reversal_of_event_id: string | null;
    }>(
      "SELECT id,event_type,reversal_of_event_id FROM consumer_wallet_events WHERE reversal_of_event_id=? AND event_type IN ('REFUND','REVERSAL') ORDER BY event_date,created_at,id",
      [event.id],
    );
    for (const refund of refunds) {
      const [existing] = await tx.query<{ group_id: string }>(
        'SELECT group_id FROM consumer_wallet_split_members WHERE wallet_event_id=?',
        [refund.id],
      );
      if (existing && existing.group_id !== id)
        throw new Error('A wallet refund already belongs to another group.');
      await tx.run(
        "INSERT INTO consumer_wallet_split_members(group_id,wallet_event_id,member_kind,member_order,created_at) VALUES(?,?,'WALLET_REFUND',?,?) ON CONFLICT(wallet_event_id) DO NOTHING",
        [id, refund.id, ++memberOrder, now],
      );
    }
  }
  return id;
}

/** Unlink/dissolve changes relationships only. Real payment entries remain untouched financially. */
export async function detachPaymentGroup(
  tx: DatabaseSession,
  transactionId: string,
  dissolve = false,
): Promise<void> {
  if (transactionId.startsWith('WALLET:')) {
    await detachWalletPaymentGroup(tx, transactionId.slice(7));
    return;
  }
  const cardOnly = transactionId.startsWith('CARD:');
  if (cardOnly) transactionId = transactionId.slice(5);
  if (
    !cardOnly &&
    (await readPaymentGroups(tx)).some((row) =>
      row.walletMembers.some((member) => member.walletEventId === transactionId),
    )
  ) {
    if (dissolve) {
      const group = (await readPaymentGroups(tx)).find((row) =>
        row.walletMembers.some((member) => member.walletEventId === transactionId),
      );
      if (group) {
        await detachPaymentGroup(tx, group.id, true);
        return;
      }
    }
    await detachWalletPaymentGroup(tx, transactionId);
    return;
  }
  const group = (await readPaymentGroups(tx)).find(
    (row) => row.id === transactionId || row.memberIds.includes(transactionId),
  );
  if (!group) return;
  const ledger = (await tx.query<{ payload: string }>('SELECT payload FROM card_transactions')).map(
    (row) => JSON.parse(row.payload) as CardTransaction,
  );
  const remaining = group.memberIds.filter((id) => id !== transactionId);
  const walletMembers = group.walletMembers;
  const clear = dissolve || remaining.length + walletMembers.length < 2;
  const removed = clear ? group.memberIds : [transactionId];
  for (const id of removed) {
    const item = ledger.find((row) => row.id === id);
    if (item) await writeMembership(tx, item, undefined);
    await tx.run('DELETE FROM transaction_split_members WHERE transaction_id=?', [id]);
  }
  if (clear) {
    await tx.run('DELETE FROM consumer_wallet_split_members WHERE group_id=?', [group.id]);
    await tx.run('DELETE FROM transaction_split_groups WHERE id=?', [group.id]);
  } else {
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
    const nextAnchorId = anchorId && remaining.includes(anchorId) ? anchorId : null;
    await tx.run(
      "UPDATE transaction_split_groups SET anchor_transaction_id=?,original_amount_minor=(SELECT COALESCE(SUM(amount_minor),0) FROM card_transactions WHERE id IN (SELECT transaction_id FROM transaction_split_members WHERE group_id=?))+(SELECT COALESCE(SUM(e.amount_minor),0) FROM consumer_wallet_split_members m JOIN consumer_wallet_events e ON e.id=m.wallet_event_id WHERE m.group_id=? AND m.member_kind='WALLET_PURCHASE'),updated_at=? WHERE id=?",
      [nextAnchorId, group.id, group.id, new Date().toISOString(), group.id],
    );
  }
}

export async function detachWalletPaymentGroup(
  tx: DatabaseSession,
  walletEventId: string,
): Promise<void> {
  const group = (await readPaymentGroups(tx)).find((row) =>
    row.walletMembers.some((member) => member.walletEventId === walletEventId),
  );
  if (!group) return;
  const member = group.walletMembers.find((item) => item.walletEventId === walletEventId);
  if (member?.memberKind === 'WALLET_PURCHASE') {
    const [dependentRefund] = await tx.query<{ id: string }>(
      `SELECT m.wallet_event_id AS id FROM consumer_wallet_split_members m
       JOIN consumer_wallet_events e ON e.id=m.wallet_event_id
       WHERE m.group_id=? AND m.member_kind='WALLET_REFUND' AND e.reversal_of_event_id=? LIMIT 1`,
      [group.id, walletEventId],
    );
    if (dependentRefund)
      throw new Error(
        'Unlink the related wallet refund before removing its purchase from the group.',
      );
  }
  await tx.run('DELETE FROM consumer_wallet_split_members WHERE wallet_event_id=?', [
    walletEventId,
  ]);
  const remainingWalletMembers = group.walletMembers.filter(
    (item) => item.walletEventId !== walletEventId,
  );
  if (group.memberIds.length + remainingWalletMembers.length < 2) {
    await tx.run('DELETE FROM transaction_split_members WHERE group_id=?', [group.id]);
    await tx.run('DELETE FROM consumer_wallet_split_members WHERE group_id=?', [group.id]);
    const ledger = (
      await tx.query<{ payload: string }>('SELECT payload FROM card_transactions')
    ).map((row) => JSON.parse(row.payload) as CardTransaction);
    for (const id of group.memberIds) {
      const item = ledger.find((row) => row.id === id);
      if (item) await writeMembership(tx, item, undefined);
    }
    await tx.run('DELETE FROM transaction_split_groups WHERE id=?', [group.id]);
    return;
  }
  const [amountRow] = await tx.query<{ total: number }>(
    `SELECT
       (SELECT COALESCE(SUM(amount_minor),0) FROM card_transactions WHERE id IN (SELECT transaction_id FROM transaction_split_members WHERE group_id=?)) +
       (SELECT COALESCE(SUM(e.amount_minor),0) FROM consumer_wallet_split_members m JOIN consumer_wallet_events e ON e.id=m.wallet_event_id WHERE m.group_id=? AND m.member_kind='WALLET_PURCHASE') AS total`,
    [group.id, group.id],
  );
  await tx.run(
    'UPDATE transaction_split_groups SET original_amount_minor=?,updated_at=? WHERE id=?',
    [Number(amountRow?.total ?? 0), new Date().toISOString(), group.id],
  );
}
