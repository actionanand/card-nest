import { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import { DATABASE_MIGRATIONS } from '../data/migrations';
import { DatabaseSession } from '../data/sqlite-database';
import { CardTransaction } from '../models/domain';
import {
  attachPaymentGroup,
  detachPaymentGroup,
  linkWalletRefundToPaymentGroup,
  readPaymentGroups,
} from './payment-groups';
import { calculateNetSpending } from './money';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
describe('Logical payment groups with real SQLite constraints', () => {
  let sql: DatabaseSyncType;
  let tx: DatabaseSession;
  const rows = (query: string, values: readonly unknown[] = []) =>
    sql.prepare(query).all(...(values as SQLInputValue[]));
  const ledger = () =>
    rows('SELECT payload FROM card_transactions').map(
      (row) => JSON.parse(String(row['payload'])) as CardTransaction,
    );
  const add = (id: string, amountMinor: number, changes: Partial<CardTransaction> = {}) => {
    const item: CardTransaction = {
      id,
      cardId: `source-${id}`,
      type: 'PURCHASE',
      amountMinor,
      currencyCode: 'INR',
      transactionDate: '2026-10-26',
      merchant: 'Local Market',
      categoryId: 'other',
      attachmentIds: [`receipt-${id}`],
      reference: `REFERENCE-${id}`,
      origin: 'SMS',
      createdAt: 'before',
      updatedAt: 'before',
      ...changes,
    };
    sql
      .prepare(
        'INSERT INTO card_transactions(id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        'other',
        item.type,
        amountMinor,
        item.currencyCode,
        item.transactionDate,
        JSON.stringify(item),
        'before',
        'before',
      );
    return item;
  };
  async function atomic<T>(work: () => Promise<T>): Promise<T> {
    sql.exec('BEGIN');
    try {
      const result = await work();
      sql.exec('COMMIT');
      return result;
    } catch (error: unknown) {
      sql.exec('ROLLBACK');
      throw error;
    }
  }
  async function addWalletPurchaseRefundHistory(
    refundType: 'REFUND' | 'REVERSAL' = 'REFUND',
  ): Promise<void> {
    await tx.run(
      "INSERT INTO consumer_wallets(id,provider_id,wallet_kind,payload,created_at,updated_at) VALUES('wallet','amazon','STANDARD','{}','before','before')",
    );
    for (const [id, eventType, date, amount, delta, reversal] of [
      ['wallet-load', 'FUNDED_LOAD', '2026-10-25', 30000, 30000, null],
      ['wallet-purchase', 'PURCHASE', '2026-10-26', 20000, -20000, null],
      ['wallet-refund', refundType, '2026-10-27', 5000, 5000, 'wallet-purchase'],
    ] as const)
      await tx.run(
        'INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,reversal_of_event_id,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [id, 'wallet', eventType, date, amount, delta, reversal, '{}', date, date],
      );
    await tx.run(
      'INSERT INTO consumer_wallet_credit_provenance(credit_event_id,source_credit_event_id,allocated_minor,created_at) VALUES(?,?,?,?)',
      ['wallet-refund', 'wallet-load', 5000, 'later'],
    );
    await tx.run(
      'INSERT INTO consumer_wallet_credit_provenance_segments(id,credit_event_id,segment_order,root_credit_event_id,source_purchase_event_id,amount_minor,created_at) VALUES(?,?,?,?,?,?,?)',
      [
        'wallet-refund:segment:0',
        'wallet-refund',
        0,
        'wallet-load',
        'wallet-purchase',
        5000,
        'later',
      ],
    );
  }
  beforeEach(() => {
    sql = new DatabaseSync(':memory:');
    sql.exec('PRAGMA foreign_keys=ON');
    for (const migration of DATABASE_MIGRATIONS)
      for (const statement of migration.statements) sql.exec(statement);
    sql.exec(
      "INSERT INTO categories(id,name,icon,applies_to) VALUES('other','Other','test','BOTH');INSERT INTO app_preferences VALUES('payment_sources','PRESERVE_BALANCES')",
    );
    tx = {
      query: async <T extends Record<string, unknown>>(s: string, v: readonly unknown[] = []) =>
        rows(s, v) as T[],
      run: async (s, v = []) => Number(sql.prepare(s).run(...(v as SQLInputValue[])).changes),
    };
  });
  afterEach(() => sql.close());
  it('resolves third, fourth and later members to one stable group without duplicating financial entries or provenance', async () => {
    const first = add('meal', 20000),
      second = add('upi', 2000, {
        type: 'ADJUSTMENT',
        adjustmentPurpose: 'SPLIT_PAYMENT',
        relatedTransactionId: first.id,
      });
    const id = await atomic(() =>
      attachPaymentGroup(tx, [second.id], first.id, {
        title: 'Market bill',
        billTotalMinor: 21000,
      }),
    );
    expect(calculateNetSpending(ledger())).toBe(22000);
    const third = add('card', 3000);
    expect(await atomic(() => attachPaymentGroup(tx, [third.id], second.id))).toBe(id);
    expect(calculateNetSpending(ledger())).toBe(25000);
    for (let i = 0; i < 25; i++) {
      const next = add(`extra-${i}`, 100);
      expect(await atomic(() => attachPaymentGroup(tx, [next.id], third.id))).toBe(id);
    }
    const [group] = await readPaymentGroups(tx);
    expect(group.memberIds).toHaveLength(28);
    expect(group.billTotalMinor).toBe(21000);
    expect(ledger().find((entry) => entry.id === first.id)).toEqual({ ...first, splitGroupId: id });
    expect(rows('SELECT encrypted_value FROM app_preferences')[0]['encrypted_value']).toBe(
      'PRESERVE_BALANCES',
    );
    expect(rows('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('combines recorded purchases idempotently, preserves separate groups and unlinks or dissolves without deleting payments', async () => {
    for (const [id, amount] of [
      ['a', 200000],
      ['b', 100000],
      ['c', 50000],
      ['d', 50000],
    ] as const)
      add(id, amount);
    const group = await atomic(() => attachPaymentGroup(tx, ['b', 'c', 'd'], 'a'));
    expect(await atomic(() => attachPaymentGroup(tx, ['a', 'b', 'c', 'd'], 'a'))).toBe(group);
    expect(calculateNetSpending(ledger())).toBe(400000);
    add('e', 100);
    add('f', 100);
    await atomic(() => attachPaymentGroup(tx, ['f'], 'e'));
    await expect(atomic(() => attachPaymentGroup(tx, ['b'], 'e'))).rejects.toThrow('another group');
    await atomic(() => detachPaymentGroup(tx, 'b'));
    expect(ledger().find((row) => row.id === 'b')?.splitGroupId).toBeUndefined();
    await atomic(() => detachPaymentGroup(tx, group, true));
    expect(ledger()).toHaveLength(6);
    expect(await readPaymentGroups(tx)).toHaveLength(1);
  });
  it('projects typed wallet purchase members without treating their IDs as card transactions', async () => {
    add('card-member', 10000);
    add('second-card-member', 5000);
    await tx.run(
      "INSERT INTO consumer_wallets(id,provider_id,wallet_kind,payload,created_at,updated_at) VALUES('wallet','amazon','STANDARD','{}','before','before')",
    );
    await tx.run(
      "INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,payload,created_at,updated_at) VALUES('wallet-purchase','wallet','PURCHASE','2026-10-26',20000,-20000,'{}','before','before')",
    );
    const groupId = await atomic(() =>
      attachPaymentGroup(tx, ['second-card-member'], 'card-member', {}, ['wallet-purchase']),
    );

    const [group] = await readPaymentGroups(tx);
    expect(group.memberIds).toEqual(['card-member', 'second-card-member']);
    expect(group.walletMembers).toEqual([
      {
        groupId,
        walletEventId: 'wallet-purchase',
        memberKind: 'WALLET_PURCHASE',
        memberOrder: 1,
        createdAt: expect.any(String),
      },
    ]);
    expect(ledger()).toHaveLength(2);
    expect(rows('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('dissolves an undersized group when unlinking a refunded wallet purchase and preserves its history', async () => {
    add('card-member', 10000);
    await addWalletPurchaseRefundHistory();
    const groupId = await atomic(() => attachPaymentGroup(tx, ['card-member'], 'wallet-purchase'));
    await atomic(() =>
      linkWalletRefundToPaymentGroup(tx, 'wallet-purchase', 'wallet-refund', 'later'),
    );

    const [group] = await readPaymentGroups(tx);
    expect(group.id).toBe(groupId);
    expect(group.walletMembers.map((member) => [member.walletEventId, member.memberKind])).toEqual([
      ['wallet-purchase', 'WALLET_PURCHASE'],
      ['wallet-refund', 'WALLET_REFUND'],
    ]);
    await atomic(() => detachPaymentGroup(tx, 'WALLET:wallet-purchase'));
    expect(await readPaymentGroups(tx)).toEqual([]);
    expect(rows('SELECT id FROM consumer_wallet_events ORDER BY id')).toEqual([
      { id: 'wallet-load' },
      { id: 'wallet-purchase' },
      { id: 'wallet-refund' },
    ]);
    expect(rows('SELECT * FROM consumer_wallet_credit_provenance')).toHaveLength(1);
    expect(rows('SELECT * FROM consumer_wallet_credit_provenance_segments')).toHaveLength(1);
    expect(groupId).toBeTruthy();
    expect(rows('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('dissolves below two actual payments when unlinking the card member, preserving wallet refund provenance', async () => {
    add('card-member', 10000);
    await addWalletPurchaseRefundHistory();
    await atomic(() => attachPaymentGroup(tx, ['card-member'], 'wallet-purchase'));
    await atomic(() =>
      linkWalletRefundToPaymentGroup(tx, 'wallet-purchase', 'wallet-refund', 'later'),
    );

    await atomic(() => detachPaymentGroup(tx, 'card-member'));

    expect(await readPaymentGroups(tx)).toEqual([]);
    expect(rows('SELECT id FROM card_transactions')).toEqual([{ id: 'card-member' }]);
    expect(rows('SELECT id FROM consumer_wallet_events')).toHaveLength(3);
    expect(rows('SELECT * FROM consumer_wallet_credit_provenance')).toHaveLength(1);
    expect(rows('SELECT * FROM consumer_wallet_credit_provenance_segments')).toHaveLength(1);
    expect(rows('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('dissolves below two actual payments when unlinking the wallet member after its refund relationship', async () => {
    add('card-member', 10000);
    await addWalletPurchaseRefundHistory();
    await atomic(() => attachPaymentGroup(tx, ['card-member'], 'wallet-purchase'));

    await atomic(() => detachPaymentGroup(tx, 'WALLET:wallet-refund'));
    expect((await readPaymentGroups(tx))[0].walletMembers).toEqual([
      expect.objectContaining({ walletEventId: 'wallet-purchase', memberKind: 'WALLET_PURCHASE' }),
    ]);
    await atomic(() => detachPaymentGroup(tx, 'WALLET:wallet-purchase'));

    expect(await readPaymentGroups(tx)).toEqual([]);
    expect(rows('SELECT id FROM card_transactions')).toHaveLength(1);
    expect(rows('SELECT id FROM consumer_wallet_events')).toHaveLength(3);
    expect(rows('SELECT * FROM consumer_wallet_credit_provenance')).toHaveLength(1);
    expect(rows('SELECT * FROM consumer_wallet_credit_provenance_segments')).toHaveLength(1);
    expect(rows('PRAGMA foreign_key_check')).toEqual([]);
  });
  it.each(['REFUND', 'REVERSAL'] as const)(
    'does not count %s history as a second payment when unlinking another wallet purchase',
    async (refundType) => {
      await addWalletPurchaseRefundHistory(refundType);
      await tx.run(
        "INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,payload,created_at,updated_at) VALUES('second-wallet-payment','wallet','PURCHASE','2026-10-26',10000,-10000,'{}','before','before')",
      );
      await atomic(() =>
        attachPaymentGroup(tx, [], 'WALLET:wallet-purchase', {}, ['second-wallet-payment']),
      );
      const beforeEvents = rows('SELECT * FROM consumer_wallet_events ORDER BY id');
      const beforeSegments = rows('SELECT * FROM consumer_wallet_credit_provenance_segments');

      await atomic(() => detachPaymentGroup(tx, 'WALLET:second-wallet-payment'));

      expect(await readPaymentGroups(tx)).toEqual([]);
      expect(rows('SELECT * FROM consumer_wallet_events ORDER BY id')).toEqual(beforeEvents);
      expect(rows('SELECT * FROM consumer_wallet_credit_provenance_segments')).toEqual(
        beforeSegments,
      );
      expect(rows('PRAGMA foreign_key_check')).toEqual([]);
    },
  );
  it('unlinks a purchase and its refund memberships while preserving two actual card payments and their anchor', async () => {
    add('first-card', 10000);
    add('second-card', 5000);
    await addWalletPurchaseRefundHistory();
    const groupId = await atomic(() =>
      attachPaymentGroup(tx, ['second-card'], 'first-card', {}, ['wallet-purchase']),
    );
    const beforeEvents = rows('SELECT * FROM consumer_wallet_events ORDER BY id');
    const beforeSegments = rows('SELECT * FROM consumer_wallet_credit_provenance_segments');

    await atomic(() => detachPaymentGroup(tx, 'WALLET:wallet-purchase'));

    const [group] = await readPaymentGroups(tx);
    expect(group.id).toBe(groupId);
    expect(group.anchorId).toBe('first-card');
    expect(group.memberIds).toEqual(['first-card', 'second-card']);
    expect(group.walletMembers).toEqual([]);
    expect(
      rows('SELECT original_amount_minor FROM transaction_split_groups')[0][
        'original_amount_minor'
      ],
    ).toBe(15000);
    expect(rows('SELECT * FROM consumer_wallet_events ORDER BY id')).toEqual(beforeEvents);
    expect(rows('SELECT * FROM consumer_wallet_credit_provenance_segments')).toEqual(
      beforeSegments,
    );
    expect(rows('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('does not use a colliding card transaction as the anchor of an explicit wallet target', async () => {
    add('same-id', 99900);
    add('chosen-card', 10000);
    await tx.run(
      "INSERT INTO consumer_wallets(id,provider_id,wallet_kind,payload,created_at,updated_at) VALUES('wallet','amazon','STANDARD','{}','before','before')",
    );
    await tx.run(
      "INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,payload,created_at,updated_at) VALUES('same-id','wallet','PURCHASE','2026-10-26',20000,-20000,'{}','before','before')",
    );
    const groupId = await atomic(() => attachPaymentGroup(tx, ['chosen-card'], 'WALLET:same-id'));
    const [group] = await readPaymentGroups(tx);
    expect(group.id).toBe(groupId);
    expect(group.anchorId).toBe('chosen-card');
    expect(group.memberIds).toEqual(['chosen-card']);
    expect(group.walletMembers.map((member) => member.walletEventId)).toEqual(['same-id']);
    expect(ledger().find((item) => item.id === 'same-id')?.splitGroupId).toBeUndefined();
    await atomic(() => detachPaymentGroup(tx, 'WALLET:same-id'));
    expect(await readPaymentGroups(tx)).toEqual([]);
    expect(ledger()).toHaveLength(2);
    expect(rows('SELECT id FROM consumer_wallet_events')).toHaveLength(1);
  });
  it.each([
    { type: 'REFUND' as const },
    { type: 'PAYMENT' as const },
    { type: 'CREDIT' as const },
    { currencyCode: 'USD' },
    { type: 'ADJUSTMENT' as const, adjustmentDirection: 'DECREASE' as const },
    { type: 'ADJUSTMENT' as const, adjustmentPurpose: 'BALANCE_RECONCILIATION' as const },
  ])('rejects incompatible member %j atomically', async (changes) => {
    add('a', 20000);
    add('b', 2000, changes);
    const before = rows('SELECT * FROM card_transactions');
    await expect(atomic(() => attachPaymentGroup(tx, ['b'], 'a'))).rejects.toThrow();
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
    expect(await readPaymentGroups(tx)).toEqual([]);
  });
  it('rejects self-only, duplicate and cyclic relationships', async () => {
    add('a', 100);
    add('b', 100, { relatedTransactionId: 'a' });
    await expect(atomic(() => attachPaymentGroup(tx, ['a'], 'a'))).rejects.toThrow('two distinct');
    await expect(atomic(() => attachPaymentGroup(tx, ['b', 'b'], 'a'))).rejects.toThrow(
      'Duplicate',
    );
    const a = ledger().find((row) => row.id === 'a')!;
    sql
      .prepare('UPDATE card_transactions SET payload=? WHERE id=?')
      .run(JSON.stringify({ ...a, relatedTransactionId: 'b' }), 'a');
    await expect(atomic(() => attachPaymentGroup(tx, ['b'], 'a'))).rejects.toThrow('Cyclic');
  });
  it('reanchors remaining members when a genuine payment is deleted, keeping the same group and clearing stale links', async () => {
    add('original', 20000);
    add('second', 2000, {
      type: 'ADJUSTMENT',
      adjustmentPurpose: 'SPLIT_PAYMENT',
      relatedTransactionId: 'original',
    });
    add('third', 3000, {
      type: 'ADJUSTMENT',
      adjustmentPurpose: 'SPLIT_PAYMENT',
      relatedTransactionId: 'original',
    });
    const id = await atomic(() => attachPaymentGroup(tx, ['second', 'third'], 'original'));
    await atomic(async () => {
      await detachPaymentGroup(tx, 'original');
      await tx.run('DELETE FROM card_transactions WHERE id=?', ['original']);
    });
    const [group] = await readPaymentGroups(tx);
    expect(group.id).toBe(id);
    expect(group.anchorId).toBe('second');
    expect(group.memberIds).toEqual(['second', 'third']);
    expect(ledger().find((entry) => entry.id === 'second')?.relatedTransactionId).toBeUndefined();
    expect(ledger().find((entry) => entry.id === 'third')?.relatedTransactionId).toBe('second');
    expect(rows('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('preserves division classification during metadata saves and changes it only when a new independent payment joins', async () => {
    add('a', 100);
    add('b', 100);
    const id = await atomic(() => attachPaymentGroup(tx, ['b'], 'a'));
    await tx.run("UPDATE transaction_split_groups SET kind='DIVISION' WHERE id=?", [id]);
    await atomic(() => attachPaymentGroup(tx, ['b'], 'a'));
    expect((await readPaymentGroups(tx))[0].kind).toBe('DIVISION');
    add('c', 100);
    await atomic(() => attachPaymentGroup(tx, ['c'], 'b'));
    expect((await readPaymentGroups(tx))[0].kind).toBe('PAYMENTS');
  });
  it('rolls back metadata and membership after a partial write fails', async () => {
    add('a', 100);
    add('b', 100);
    const before = rows('SELECT * FROM card_transactions');
    sql.exec(
      "CREATE TRIGGER fail_member BEFORE INSERT ON transaction_split_members WHEN NEW.transaction_id='b' BEGIN SELECT RAISE(ABORT,'Synthetic group failure'); END",
    );
    await expect(atomic(() => attachPaymentGroup(tx, ['b'], 'a'))).rejects.toThrow(
      'Synthetic group failure',
    );
    expect(rows('SELECT * FROM card_transactions')).toEqual(before);
    expect(await readPaymentGroups(tx)).toEqual([]);
  });
});
