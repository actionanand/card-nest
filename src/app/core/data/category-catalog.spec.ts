import { DATABASE_MIGRATIONS } from './migrations';
import {
  DEFAULT_CATEGORIES,
  CATEGORY_REGISTRY,
  formatNewCategoryName,
  normalizedCategoryName,
  validateCategoryRegistry,
} from './category-definitions';
import { reconcileCategoryCatalog, deletePersistedCategory } from './category-catalog';
import type { DatabaseSession } from './sqlite-database';
import type { DatabaseSync as Sqlite, SQLInputValue } from 'node:sqlite';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
describe('Versioned category catalog with real SQLite foreign keys', () => {
  it('propagates draft persistence errors so the whole category deletion rolls back', async () => {
    sql.exec("INSERT INTO app_preferences VALUES('initial_data_state','PENDING')");
    await atomic(() => reconcileCategoryCatalog(tx));
    sql
      .prepare('INSERT INTO app_preferences VALUES(?,?)')
      .run(
        'sms_purchase_review:failure',
        JSON.stringify({ category: 'kids', categoryOverridden: true }),
      );
    sql.exec(
      "CREATE TRIGGER fail_draft BEFORE UPDATE ON app_preferences WHEN NEW.key LIKE 'sms_purchase_review:%' BEGIN SELECT RAISE(ABORT,'draft remap failure'); END",
    );
    await expect(atomic(() => deletePersistedCategory(tx, 'kids'))).rejects.toThrow(
      'draft remap failure',
    );
    expect(rows("SELECT id FROM categories WHERE id='kids'")).toEqual([{ id: 'kids' }]);
    expect(rows("SELECT deleted FROM category_catalog_state WHERE canonical_id='kids'")).toEqual([
      { deleted: 0 },
    ]);
  });
  let sql: Sqlite;
  let tx: DatabaseSession;
  const rows = (query: string, ...values: SQLInputValue[]) => sql.prepare(query).all(...values);
  const category = (id: string, name: string, icon = 'custom', colour = '#123456') =>
    sql
      .prepare(
        'INSERT INTO categories(id,name,icon,colour,applies_to,archived) VALUES(?,?,?,?,?,0)',
      )
      .run(id, name, icon, colour, 'BOTH');
  const atomic = async (fn: () => Promise<void>) => {
    sql.exec('BEGIN');
    try {
      await fn();
      sql.exec('COMMIT');
    } catch (error) {
      sql.exec('ROLLBACK');
      throw error;
    }
  };
  beforeEach(() => {
    sql = new DatabaseSync(':memory:');
    sql.exec('PRAGMA foreign_keys=ON');
    for (const migration of DATABASE_MIGRATIONS)
      for (const statement of migration.statements) sql.exec(statement);
    sql.exec(
      "INSERT INTO credit_cards(id,nickname,issuer_name,last_digits,network,payload,created_at,updated_at) VALUES('fixture-card','Fiction card','Fiction','4321','VISA','{}','before','before')",
    );
    tx = {
      query: async <T extends Record<string, unknown>>(
        query: string,
        values: readonly unknown[] = [],
      ) => rows(query, ...(values as SQLInputValue[])) as T[],
      run: async (query, values = []) =>
        Number(sql.prepare(query).run(...(values as SQLInputValue[])).changes),
    };
  });
  afterEach(() => sql.close());
  it('creates exactly 24 canonical categories on a pristine installation and is idempotent', async () => {
    sql.exec("INSERT INTO app_preferences VALUES('initial_data_state','PENDING')");
    await atomic(() => reconcileCategoryCatalog(tx));
    expect(rows('SELECT id,name FROM categories ORDER BY id')).toEqual(
      [...DEFAULT_CATEGORIES]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(({ id, name }) => ({ id, name })),
    );
    const before = rows('SELECT * FROM categories ORDER BY id');
    await atomic(() => reconcileCategoryCatalog(tx));
    expect(rows('SELECT * FROM categories ORDER BY id')).toEqual(before);
  });
  it.each(CATEGORY_REGISTRY.categories.filter((row) => row.introduced > 1))(
    'reuses an existing custom $name with its original identity and metadata',
    async (def) => {
      category('uuid', `  ${def.name.toLocaleUpperCase()}   `);
      category('other', 'Other');
      sql.exec("INSERT INTO category_limits VALUES('uuid',500000,1,'before')");
      await atomic(() => reconcileCategoryCatalog(tx));
      expect(rows('SELECT * FROM categories WHERE id=?', 'uuid')[0]).toMatchObject({
        name: def.name,
        icon: 'custom',
        colour: '#123456',
      });
      expect(rows('SELECT * FROM categories WHERE id=?', def.id)).toEqual([]);
      expect(rows('SELECT * FROM category_limits WHERE category_id=?', 'uuid')[0]).toMatchObject({
        limit_minor: 500000,
        show_limit: 1,
      });
      expect(
        rows('SELECT * FROM category_catalog_state WHERE canonical_id=?', def.id)[0],
      ).toMatchObject({ category_id: 'uuid', deleted: 0 });
    },
  );
  it.each([
    ['groceries', 'Groceries', 'Pantry Staples'],
    ['travel', 'Travel', 'Travel & Lodging'],
  ])(
    'atomically reconciles %s rename collisions, both histories, templates, drafts and conflicting budgets',
    async (id, oldName, newName) => {
      category(id, oldName);
      category('uuid', newName);
      category('other', 'Other');
      sql.prepare('INSERT INTO category_limits VALUES(?,20000,1,?)').run(id, 'before');
      sql.exec("INSERT INTO category_limits VALUES('uuid',500000,0,'before')");
      const item = {
        id: 'payment',
        categoryId: 'uuid',
        amountMinor: 12000,
        reference: 'KEEP',
        attachmentIds: ['receipt'],
        splitGroupId: 'group',
        origin: 'SMS',
      };
      sql
        .prepare(
          'INSERT INTO card_transactions(id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,?,?,12000,?,?,?, ?,?)',
        )
        .run(
          'payment',
          'uuid',
          'PURCHASE',
          'INR',
          '2026-10-01',
          JSON.stringify(item),
          'before',
          'before',
        );
      sql
        .prepare('INSERT INTO recurring_rules(id,card_id,status,payload) VALUES(?,?,?,?)')
        .run(
          'rule',
          'fixture-card',
          'ACTIVE',
          JSON.stringify({ categoryId: 'uuid', amountMinor: 123 }),
        );
      sql
        .prepare('INSERT INTO app_preferences VALUES(?,?)')
        .run(
          'sms_purchase_review:one',
          JSON.stringify({ category: 'uuid', categoryOverridden: true }),
        );
      await atomic(() => reconcileCategoryCatalog(tx));
      expect(rows('SELECT id,name FROM categories WHERE id=?', id)).toEqual([
        { id, name: newName },
      ]);
      expect(rows('SELECT * FROM categories WHERE id=?', 'uuid')).toEqual([]);
      const stored = rows('SELECT * FROM card_transactions')[0];
      expect(stored).toMatchObject({
        category_id: id,
        amount_minor: 12000,
        created_at: 'before',
        updated_at: 'before',
      });
      expect(JSON.parse(String(stored['payload']))).toEqual({ ...item, categoryId: id });
      expect(JSON.parse(String(rows('SELECT payload FROM recurring_rules')[0]['payload']))).toEqual(
        { categoryId: id, amountMinor: 123 },
      );
      expect(
        rows('SELECT limit_minor,show_limit FROM category_limits WHERE category_id=?', id),
      ).toEqual([{ limit_minor: 20000, show_limit: 1 }]);
      const record = JSON.parse(
        String(rows('SELECT details FROM category_catalog_conflicts')[0]['details']),
      );
      expect(record.budgets).toHaveLength(2);
      expect(record.merged.icon).toBe('custom');
      const snapshot = rows('SELECT * FROM card_transactions');
      await atomic(() => reconcileCategoryCatalog(tx));
      expect(rows('SELECT * FROM card_transactions')).toEqual(snapshot);
      expect(rows('PRAGMA foreign_key_check')).toEqual([]);
    },
  );
  it('preserves the sole custom budget when the retained category has none', async () => {
    category('groceries', 'Groceries');
    category('uuid', 'Pantry Staples');
    sql.exec("INSERT INTO category_limits VALUES('uuid',10000,0,'before')");
    await atomic(() => reconcileCategoryCatalog(tx));
    expect(rows('SELECT * FROM category_limits')[0]).toMatchObject({
      category_id: 'groceries',
      limit_minor: 10000,
      show_limit: 0,
    });
  });
  it('does not resurrect removed old defaults, archived defaults, or user-renamed metadata', async () => {
    category('groceries', 'My essentials');
    category('other', 'Other');
    sql.exec("UPDATE categories SET archived=1 WHERE id='groceries'");
    await atomic(() => reconcileCategoryCatalog(tx));
    expect(rows("SELECT * FROM categories WHERE id='groceries'")[0]).toMatchObject({
      name: 'My essentials',
      archived: 1,
      colour: '#123456',
    });
    expect(rows("SELECT * FROM categories WHERE id='travel'")).toEqual([]);
    expect(rows("SELECT deleted FROM category_catalog_state WHERE canonical_id='travel'")).toEqual([
      { deleted: 1 },
    ]);
  });
  it('rolls back every collision write on a persistence error', async () => {
    category('groceries', 'Groceries');
    category('uuid', 'Pantry Staples');
    sql.exec(
      "CREATE TRIGGER fail_catalog BEFORE UPDATE OF name ON categories BEGIN SELECT RAISE(ABORT,'catalog failure'); END",
    );
    await expect(atomic(() => reconcileCategoryCatalog(tx))).rejects.toThrow('catalog failure');
    expect(rows('SELECT id,name FROM categories ORDER BY id')).toEqual([
      { id: 'groceries', name: 'Groceries' },
      { id: 'uuid', name: 'Pantry Staples' },
    ]);
    expect(rows('SELECT * FROM category_catalog_conflicts')).toEqual([]);
    expect(rows('SELECT * FROM category_catalog_state')).toEqual([]);
  });
  it('deletes ordinary categories atomically, reassigns every category reference and persists tombstones', async () => {
    sql.exec("INSERT INTO app_preferences VALUES('initial_data_state','PENDING')");
    await atomic(() => reconcileCategoryCatalog(tx));
    const payload = {
      id: 't',
      categoryId: 'kids',
      amountMinor: 500,
      reference: 'UNCHANGED',
      attachmentIds: ['photo'],
      origin: 'SMS',
    };
    sql
      .prepare(
        "INSERT INTO card_transactions(id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES('t','kids','PURCHASE',500,'INR','2026-10-01',?,'before','before')",
      )
      .run(JSON.stringify(payload));
    sql.exec("INSERT INTO category_limits VALUES('kids',500000,1,'before')");
    sql
      .prepare(
        "INSERT INTO recurring_rules(id,card_id,status,payload) VALUES('r','fixture-card','ACTIVE',?)",
      )
      .run(JSON.stringify({ categoryId: 'kids' }));
    await atomic(() => deletePersistedCategory(tx, 'kids'));
    expect(JSON.parse(String(rows('SELECT payload FROM card_transactions')[0]['payload']))).toEqual(
      { ...payload, categoryId: 'other' },
    );
    expect(rows('SELECT category_id,amount_minor,updated_at FROM card_transactions')).toEqual([
      { category_id: 'other', amount_minor: 500, updated_at: 'before' },
    ]);
    expect(rows('SELECT * FROM category_limits')).toEqual([]);
    expect(rows("SELECT deleted FROM category_catalog_state WHERE canonical_id='kids'")).toEqual([
      { deleted: 1 },
    ]);
    await atomic(() => reconcileCategoryCatalog(tx));
    expect(rows("SELECT * FROM categories WHERE id='kids'")).toEqual([]);
    expect(rows('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('rolls back deletion, references, settings and tombstones after failure', async () => {
    sql.exec("INSERT INTO app_preferences VALUES('initial_data_state','PENDING')");
    await atomic(() => reconcileCategoryCatalog(tx));
    sql.exec(
      "INSERT INTO category_limits VALUES('kids',5000,1,'before');CREATE TRIGGER fail_delete BEFORE DELETE ON categories BEGIN SELECT RAISE(ABORT,'delete failure'); END",
    );
    await expect(atomic(() => deletePersistedCategory(tx, 'kids'))).rejects.toThrow(
      'delete failure',
    );
    expect(rows("SELECT deleted FROM category_catalog_state WHERE canonical_id='kids'")).toEqual([
      { deleted: 0 },
    ]);
    expect(rows('SELECT * FROM category_limits')).toHaveLength(1);
  });
  it.each(['other', 'payment'])('protects essential %s', async (id) => {
    await expect(atomic(() => deletePersistedCategory(tx, id))).rejects.toThrow('essential');
  });
  it('normalizes Unicode and whitespace without fuzzy word matching or damaging custom brands', () => {
    expect(normalizedCategoryName('  ＫＩＤＳ  ')).toBe('kids');
    expect(formatNewCategoryName('  meat  & dairy ')).toBe('Meat & Dairy');
    expect(formatNewCategoryName('my IKEA eBay club')).toBe('My IKEA eBay Club');
    expect(formatNewCategoryName('KIDS')).toBe('Kids');
    expect(() =>
      validateCategoryRegistry({
        ...CATEGORY_REGISTRY,
        categories: [...CATEGORY_REGISTRY.categories, CATEGORY_REGISTRY.categories[0]],
      }),
    ).toThrow();
  });
});
