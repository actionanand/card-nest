import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';
import { Service, signal } from '@angular/core';
import { DATABASE_MIGRATIONS } from './migrations';

interface JeepSqliteElement extends HTMLElement {
  wasmPath: string;
}

interface PortableBackupTable {
  readonly name: string;
  readonly rows: readonly Record<string, unknown>[];
}

interface PortableBackup {
  readonly format: 'cardnest-portable-sqlite';
  readonly version: 1;
  readonly databaseVersion: number;
  readonly tables: readonly PortableBackupTable[];
}

// The Android SQLite JSON exporter fails when a newer migration makes the SQL text
// longer than the table definition it cached. Exporting the application tables directly
// avoids that native substring bug and also gives CardNest a stable, plugin-independent
// backup format.
const BACKUP_TABLES = [
  'app_preferences',
  'categories',
  'credit_cards',
  'card_relationship_groups',
  'card_relationship_members',
  'card_benefits',
  'card_important_links',
  'card_secrets',
  'card_transactions',
  'transaction_links',
  'transaction_split_groups',
  'transaction_split_members',
  'statements',
  'recurring_rules',
  'attachments',
  'emi_plans',
  'emi_installments',
  'monthly_income',
  'category_limits',
] as const;

const DELETE_TABLES = [
  'transaction_links',
  'transaction_split_members',
  'transaction_split_groups',
  'attachments',
  'emi_installments',
  'emi_plans',
  'statements',
  'recurring_rules',
  'card_transactions',
  'card_benefits',
  'card_important_links',
  'card_relationship_members',
  'card_relationship_groups',
  'card_secrets',
  'credit_cards',
  'category_limits',
  'categories',
  'monthly_income',
  'app_preferences',
] as const;

/** SQLite gateway. The web build uses the jeep-sqlite WASM database, never key/value app storage. */
@Service()
export class SqliteDatabase {
  private readonly databaseName = 'cardnest';
  private readonly isWeb = Capacitor.getPlatform() === 'web';
  readonly ready = signal(false);
  readonly unavailableReason = signal<string | null>(null);

  async initialise(): Promise<void> {
    try {
      if (this.isWeb) await this.initialiseWebStore();
      const version = DATABASE_MIGRATIONS.at(-1)?.version ?? 1;

      // On a warm restart the native layer can still hold the connection from a previous
      // activity instance, making a plain createConnection() throw. Treat that as success
      // and continue to open/migrate with the existing connection.
      try {
        await CapacitorSQLite.createConnection({
          database: this.databaseName,
          version,
          encrypted: false,
          mode: 'no-encryption',
          readonly: false,
        });
      } catch (createError: unknown) {
        const msg = createError instanceof Error ? createError.message : String(createError);
        // Ignore "connection already exists" — reuse the live connection.
        if (!msg.toLowerCase().includes('already')) throw createError;
      }

      try {
        await CapacitorSQLite.open({ database: this.databaseName, readonly: false });
      } catch (openError: unknown) {
        const msg = openError instanceof Error ? openError.message : String(openError);
        // Ignore "database already open" on a warm restart.
        if (!msg.toLowerCase().includes('already')) throw openError;
      }

      await CapacitorSQLite.execute({
        database: this.databaseName,
        statements: 'PRAGMA foreign_keys = ON;',
        transaction: false,
      });
      const result = await CapacitorSQLite.query({
        database: this.databaseName,
        statement: 'PRAGMA user_version;',
        values: [],
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
      const detail = error instanceof Error ? error.message : String(error);
      this.unavailableReason.set(
        detail.includes('WebAssembly')
          ? 'The installed SQLite WebAssembly file is incompatible.'
          : `The local SQLite database could not be opened. (${detail})`,
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
    if (this.isWeb) await CapacitorSQLite.saveToStore({ database: this.databaseName });
    return result.changes?.changes ?? 0;
  }

  async exportBackupJson(): Promise<string> {
    if (!this.ready()) throw new Error('SQLite database is unavailable.');
    if (!this.isWeb) return this.exportPortableBackupJson();
    const result = await CapacitorSQLite.exportToJson({
      database: this.databaseName,
      jsonexportmode: 'full',
      // CardNest keeps a read/write jeep-sqlite connection on web. Asking the plugin
      // for a separate read-only connection produces "No available connection".
      readonly: false,
    });
    if (!result.export) throw new Error('The database could not be exported.');
    return JSON.stringify(result.export);
  }

  async restoreBackupJson(json: string): Promise<void> {
    if (!this.ready()) throw new Error('SQLite database is unavailable.');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed['format'] === 'cardnest-portable-sqlite') {
      await this.restorePortableBackup(parsed);
      return;
    }
    parsed['database'] = this.databaseName;
    parsed['overwrite'] = true;
    parsed['encrypted'] = false;
    parsed['mode'] = 'full';
    const jsonstring = JSON.stringify(parsed);
    const validation = await CapacitorSQLite.isJsonValid({ jsonstring });
    if (!validation.result) throw new Error('The backup database is invalid.');

    try {
      await CapacitorSQLite.close({ database: this.databaseName });
    } catch {
      // A closed connection is safe to continue with.
    }
    try {
      await CapacitorSQLite.closeConnection({ database: this.databaseName, readonly: false });
    } catch {
      // The importer can continue when no retained connection exists.
    }
    this.ready.set(false);
    await CapacitorSQLite.importFromJson({ jsonstring });
    // jeep-sqlite imports through a temporary Database and persists it while closing that
    // database. There is no retained RW connection after import, so calling saveToStore()
    // here fails with "No available connection for cardnest" even though import succeeded.
  }

  async deleteAllData(): Promise<void> {
    if (!this.ready()) throw new Error('SQLite database is unavailable.');
    await CapacitorSQLite.execute({
      database: this.databaseName,
      transaction: true,
      statements: DELETE_TABLES.map((table) => `DELETE FROM ${table}`).join(';\n'),
    });
    if (this.isWeb) await CapacitorSQLite.saveToStore({ database: this.databaseName });
  }

  private async exportPortableBackupJson(): Promise<string> {
    const versionResult = await CapacitorSQLite.query({
      database: this.databaseName,
      statement: 'PRAGMA user_version;',
      values: [],
    });
    const tables: PortableBackupTable[] = [];
    for (const name of BACKUP_TABLES) {
      const result = await CapacitorSQLite.query({
        database: this.databaseName,
        statement: `SELECT * FROM ${name}`,
        values: [],
      });
      tables.push({ name, rows: (result.values ?? []) as Record<string, unknown>[] });
    }
    const backup: PortableBackup = {
      format: 'cardnest-portable-sqlite',
      version: 1,
      databaseVersion: Number(versionResult.values?.[0]?.['user_version'] ?? 0),
      tables,
    };
    return JSON.stringify(backup);
  }

  private async restorePortableBackup(value: Record<string, unknown>): Promise<void> {
    if (value['version'] !== 1 || !Array.isArray(value['tables'])) {
      throw new Error('The backup database is invalid.');
    }
    const allowedTables = new Set<string>(BACKUP_TABLES);
    const backupTables = new Map<string, readonly Record<string, unknown>[]>();
    for (const item of value['tables']) {
      if (
        !this.isRecord(item) ||
        typeof item['name'] !== 'string' ||
        !Array.isArray(item['rows'])
      ) {
        throw new Error('The backup database is invalid.');
      }
      if (!allowedTables.has(item['name']) || !item['rows'].every((row) => this.isRecord(row))) {
        throw new Error('The backup database contains an unsupported table.');
      }
      backupTables.set(item['name'], item['rows'] as readonly Record<string, unknown>[]);
    }

    await CapacitorSQLite.beginTransaction({ database: this.databaseName });
    try {
      await CapacitorSQLite.execute({
        database: this.databaseName,
        transaction: false,
        statements: DELETE_TABLES.map((table) => `DELETE FROM ${table}`).join(';\n'),
      });
      for (const table of BACKUP_TABLES) {
        for (const row of backupTables.get(table) ?? []) {
          const columns = Object.keys(row);
          if (!columns.length || columns.some((column) => !/^[a-z][a-z0-9_]*$/i.test(column))) {
            throw new Error('The backup database contains invalid columns.');
          }
          await CapacitorSQLite.run({
            database: this.databaseName,
            statement: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
            values: columns.map((column) => row[column]),
            transaction: false,
          });
        }
      }
      await CapacitorSQLite.commitTransaction({ database: this.databaseName });
    } catch (error: unknown) {
      await CapacitorSQLite.rollbackTransaction({ database: this.databaseName });
      throw error;
    }
    if (this.isWeb) await CapacitorSQLite.saveToStore({ database: this.databaseName });
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private async initialiseWebStore(): Promise<void> {
    await customElements.whenDefined('jeep-sqlite');
    const element = document.querySelector<JeepSqliteElement>('jeep-sqlite');
    if (!element) throw new Error('The jeep-sqlite host element is missing.');
    element.wasmPath = new URL('assets', document.baseURI).pathname.replace(/\/$/, '');
    await CapacitorSQLite.initWebStore();
  }
}
