import { Service, signal } from '@angular/core';
import { DATABASE_MIGRATIONS } from './migrations';

interface SqliteResult {
  readonly changes?: { readonly changes?: number };
  readonly values?: readonly Record<string, unknown>[];
}
interface SqlitePlugin {
  createConnection(options: {
    database: string;
    version: number;
    encrypted: boolean;
    mode: string;
  }): Promise<void>;
  open(options: { database: string; readonly: boolean }): Promise<void>;
  execute(options: {
    database: string;
    statements: string;
    transaction: boolean;
  }): Promise<SqliteResult>;
  query(options: {
    database: string;
    statement: string;
    values?: readonly unknown[];
  }): Promise<SqliteResult>;
  run(options: {
    database: string;
    statement: string;
    values?: readonly unknown[];
    transaction: boolean;
  }): Promise<SqliteResult>;
}

function nativeSqlitePlugin(): SqlitePlugin | undefined {
  const runtime = globalThis as typeof globalThis & {
    Capacitor?: { Plugins?: { CapacitorSQLite?: SqlitePlugin } };
  };
  return runtime.Capacitor?.Plugins?.CapacitorSQLite;
}

/** Native SQLite gateway. It deliberately has no browser key/value storage fallback. */
@Service()
export class SqliteDatabase {
  private readonly databaseName = 'cardnest';
  readonly ready = signal(false);
  readonly unavailableReason = signal<string | null>(null);

  async initialise(): Promise<void> {
    const plugin = nativeSqlitePlugin();
    if (!plugin) {
      this.unavailableReason.set('SQLite runtime is not installed for this platform.');
      return;
    }
    try {
      await plugin.createConnection({
        database: this.databaseName,
        version: DATABASE_MIGRATIONS.at(-1)?.version ?? 1,
        encrypted: false,
        mode: 'no-encryption',
      });
      await plugin.open({ database: this.databaseName, readonly: false });
      await plugin.execute({
        database: this.databaseName,
        statements: 'PRAGMA foreign_keys = ON;',
        transaction: false,
      });
      const result = await plugin.query({
        database: this.databaseName,
        statement: 'PRAGMA user_version;',
      });
      const currentVersion = Number(result.values?.[0]?.['user_version'] ?? 0);
      for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version > currentVersion)) {
        await plugin.execute({
          database: this.databaseName,
          statements: [...migration.statements, `PRAGMA user_version = ${migration.version};`].join(
            ';\n',
          ),
          transaction: true,
        });
      }
      this.ready.set(true);
      this.unavailableReason.set(null);
    } catch {
      this.ready.set(false);
      this.unavailableReason.set('The encrypted local database could not be opened.');
    }
  }

  async query<T extends Record<string, unknown>>(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<readonly T[]> {
    const plugin = nativeSqlitePlugin();
    if (!plugin || !this.ready()) throw new Error('SQLite database is unavailable.');
    const result = await plugin.query({ database: this.databaseName, statement, values });
    return (result.values ?? []) as readonly T[];
  }

  async run(statement: string, values: readonly unknown[] = []): Promise<number> {
    const plugin = nativeSqlitePlugin();
    if (!plugin || !this.ready()) throw new Error('SQLite database is unavailable.');
    const result = await plugin.run({
      database: this.databaseName,
      statement,
      values,
      transaction: true,
    });
    return result.changes?.changes ?? 0;
  }
}
