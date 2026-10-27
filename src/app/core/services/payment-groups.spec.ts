import { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import { DATABASE_MIGRATIONS } from '../data/migrations';
import { DatabaseSession } from '../data/sqlite-database';
import { CardTransaction } from '../models/domain';
import { attachPaymentGroup, detachPaymentGroup, readPaymentGroups } from './payment-groups';
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
