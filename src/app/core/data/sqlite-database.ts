import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';
import { Service, signal } from '@angular/core';
import { DATABASE_MIGRATIONS } from './migrations';

interface JeepSqliteElement extends HTMLElement {
  wasmPath: string;
}

/** SQLite gateway. The web build uses the jeep-sqlite WASM database, never key/value app storage. */
@Service()
export class SqliteDatabase {
  private readonly databaseName = 'cardnest';
  readonly ready = signal(false);
  readonly unavailableReason = signal<string | null>(null);

  async initialise(): Promise<void> {
    try {
      if (Capacitor.getPlatform() === 'web') await this.initialiseWebStore();
      await CapacitorSQLite.createConnection({
        database: this.databaseName,
        version: DATABASE_MIGRATIONS.at(-1)?.version ?? 1,
        encrypted: false,
        mode: 'no-encryption',
        readonly: false,
      });
      await CapacitorSQLite.open({ database: this.databaseName, readonly: false });
      await CapacitorSQLite.execute({
        database: this.databaseName,
        statements: 'PRAGMA foreign_keys = ON;',
        transaction: false,
      });
      const result = await CapacitorSQLite.query({
        database: this.databaseName,
        statement: 'PRAGMA user_version;',
      });
      const currentVersion = Number(result.values?.[0]?.['user_version'] ?? 0);
      for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version > currentVersion)) {
        await CapacitorSQLite.execute({
          database: this.databaseName,
          statements: [...migration.statements, `PRAGMA user_version = ${migration.version};`].join(
            ';\n',
          ),
          transaction: true,
        });
      }
      this.ready.set(true);
      this.unavailableReason.set(null);
    } catch (error: unknown) {
      this.ready.set(false);
      this.unavailableReason.set(
        error instanceof Error && error.message.includes('WebAssembly')
          ? 'The installed SQLite WebAssembly file is incompatible.'
          : 'The local SQLite database could not be opened.',
      );
    }
  }

  async query<T extends Record<string, unknown>>(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<readonly T[]> {
    if (!this.ready()) throw new Error('SQLite database is unavailable.');
    const result = await CapacitorSQLite.query({
      database: this.databaseName,
      statement,
      values: [...values],
    });
    return (result.values ?? []) as readonly T[];
  }

  async run(statement: string, values: readonly unknown[] = []): Promise<number> {
    if (!this.ready()) throw new Error('SQLite database is unavailable.');
    const result = await CapacitorSQLite.run({
      database: this.databaseName,
      statement,
      values: [...values],
      transaction: true,
    });
    return result.changes?.changes ?? 0;
  }

  private async initialiseWebStore(): Promise<void> {
    await customElements.whenDefined('jeep-sqlite');
    const element = document.querySelector<JeepSqliteElement>('jeep-sqlite');
    if (!element) throw new Error('The jeep-sqlite host element is missing.');
    element.wasmPath = new URL('assets', document.baseURI).pathname.replace(/\/$/, '');
    await CapacitorSQLite.initWebStore();
  }
}
