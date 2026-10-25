import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

// Angular's test setup may pre-import the SQLite plugin before this spec's
// hoisted mock is registered (observed in clean GitHub Actions builds).
// Clear preloaded modules *before* static imports so this spec and SqliteDatabase
// both receive the same mocked CapacitorSQLite implementation.
vi.hoisted(() => {
  vi.resetModules();
});
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { DATABASE_MIGRATIONS } from './migrations';
import { SqliteDatabase } from './sqlite-database';

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {
    createConnection: vi.fn(),
    open: vi.fn(),
    beginTransaction: vi.fn(),
    commitTransaction: vi.fn(),
    rollbackTransaction: vi.fn(),
    run: vi.fn(),
    query: vi.fn(),
    execute: vi.fn(),
    saveToStore: vi.fn(),
  },
}));

describe('SQLite shared write queue', () => {
  const currentSchemaVersion = DATABASE_MIGRATIONS.at(-1)!.version;
  let database: SqliteDatabase;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    TestBed.configureTestingModule({ providers: [SqliteDatabase] });
    database = TestBed.inject(SqliteDatabase);
    database.ready.set(true);
    vi.mocked(CapacitorSQLite.run).mockResolvedValue({ changes: { changes: 1 } });
    vi.mocked(CapacitorSQLite.query).mockResolvedValue({ values: [] });
  });
  afterEach(() => vi.restoreAllMocks());
  it('upgrades a version-6 Android database through every additive migration without dropping user data', async () => {
    database.ready.set(false);
    vi.mocked(CapacitorSQLite.query).mockResolvedValue({ values: [{ user_version: 6 }] });
    await database.initialise();
    expect(CapacitorSQLite.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        database: 'cardnest',
        version: currentSchemaVersion,
        readonly: false,
      }),
    );
    expect(CapacitorSQLite.open).toHaveBeenCalledOnce();
    const migrations = vi
      .mocked(CapacitorSQLite.execute)
      .mock.calls.map(([options]) => options)
      .filter((options) => options.transaction);
    const pendingMigrations = DATABASE_MIGRATIONS.filter((migration) => migration.version > 6);
    expect(migrations).toHaveLength(pendingMigrations.length);
    for (const [index, migration] of pendingMigrations.entries()) {
      expect(migrations[index].statements).toContain(`PRAGMA user_version = ${migration.version}`);
      for (const statement of migration.statements)
        expect(migrations[index].statements).toContain(statement);
      expect(migrations[index].statements).not.toMatch(/\bDROP\s+TABLE\b/i);
      expect(migrations[index].statements).not.toMatch(/\bDELETE\s+FROM\b/i);
    }
    expect(pendingMigrations.map((migration) => migration.version)).toEqual(
      Array.from({ length: currentSchemaVersion - 6 }, (_, index) => index + 7),
    );
    expect(database.ready()).toBe(true);
  });
  it('does not expose a ready database after an SMS migration failure', async () => {
    database.ready.set(false);
    vi.mocked(CapacitorSQLite.query).mockResolvedValue({ values: [{ user_version: 6 }] });
    vi.mocked(CapacitorSQLite.execute).mockImplementation(async (options) => {
      if (options.transaction) throw new Error('Synthetic migration failure');
      return { changes: { changes: 0 } };
    });
    await database.initialise();
    expect(database.ready()).toBe(false);
    expect(database.unavailableReason()).toContain('Synthetic migration failure');
    vi.mocked(CapacitorSQLite.execute).mockReset();
  });
  it('serializes standalone writes after an entire import transaction', async () => {
    const events: string[] = [];
    vi.mocked(CapacitorSQLite.beginTransaction).mockImplementation(async () => {
      events.push('begin');
      return { changes: { changes: 0 } };
    });
    vi.mocked(CapacitorSQLite.commitTransaction).mockImplementation(async () => {
      events.push('commit');
      return { changes: { changes: 0 } };
    });
    vi.mocked(CapacitorSQLite.run).mockImplementation(async (options) => {
      events.push(options.statement ?? '');
      return { changes: { changes: 1 } };
    });
    let release: () => void = () => {
      throw new Error('Gate was not initialized');
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const importWork = database.atomic(async (tx) => {
      await tx.run('import-ledger');
      await gate;
      await tx.run('import-binding');
    });
    const manualWrite = database.run('manual-write');
    await Promise.resolve();
    await Promise.resolve();
    expect(events).not.toContain('manual-write');
    release();
    await Promise.all([importWork, manualWrite]);
    expect(events).toEqual(['begin', 'import-ledger', 'import-binding', 'commit', 'manual-write']);
  });
  it('rolls back on failure and keeps the queue usable', async () => {
    await expect(
      database.atomic(async (tx) => {
        await tx.run('ledger');
        throw new Error('synthetic failure');
      }),
    ).rejects.toThrow('synthetic failure');
    expect(CapacitorSQLite.rollbackTransaction).toHaveBeenCalledOnce();
    expect(CapacitorSQLite.commitTransaction).not.toHaveBeenCalled();
    await expect(database.run('next-write')).resolves.toBe(1);
  });
  it('backs up processing tombstones without extracted message payloads', async () => {
    const value = JSON.parse(await database.exportBackupJson()) as { tables: { name: string }[] };
    expect(value.tables.some((t) => t.name === 'sms_candidates')).toBe(true);
    expect(
      vi
        .mocked(CapacitorSQLite.query)
        .mock.calls.some(([options]) => options.statement?.includes('NULL AS payload')),
    ).toBe(true);
  });
  it('deletes all new review and reconciliation tables and rejects invalid retention dates', async () => {
    await database.deleteAllData();
    const statement = vi.mocked(CapacitorSQLite.execute).mock.calls[0][0].statements;
    expect(statement).toContain('DELETE FROM sms_reconciliation');
    expect(statement).toContain('DELETE FROM sms_candidates');
    expect(statement).toContain('DELETE FROM sms_sync_state');
    await expect(database.deleteDataOlderThan("bad-date' OR 1=1")).rejects.toThrow(
      'Invalid retention date',
    );
  });
});
