import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { SqliteDatabase } from './sqlite-database';

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {
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
