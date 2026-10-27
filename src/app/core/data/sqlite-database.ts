import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';
import { Service, signal } from '@angular/core';
import { CLASSIFY_LEGACY_ADJUSTMENTS, DATABASE_MIGRATIONS } from './migrations';
import { clearPlatformDiscovery, prunePlatformDiscovery } from './platform-data';
import { INITIAL_DATA_KEY } from './app-initialization';
import { reconcileCategoryCatalog } from './category-catalog';

interface JeepSqliteElement extends HTMLElement {
  wasmPath: string;
}

export interface DatabaseSession {
  query<T extends Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<readonly T[]>;
  run(statement: string, values?: readonly unknown[]): Promise<number>;
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
  'loan_commitments',
  'monthly_income',
  'category_limits',
  'category_catalog_state',
  'category_catalog_conflicts',
  'utility_profiles',
  'mobile_recharges',
  'lpg_events',
  'bank_activity_profiles',
  'bank_activity_events',
  'bank_activity_candidates',
  'sms_candidates',
  'sms_reconciliation',
  'sms_sync_state',
  'source_transfers',
  'source_balance_adjustments',
] as const;

const DELETE_TABLES = [
  'category_catalog_state',
  'category_catalog_conflicts',
  'bank_activity_candidates',
  'bank_activity_events',
  'bank_activity_profiles',
  'lpg_events',
  'mobile_recharges',
  'utility_profiles',
  'source_balance_adjustments',
  'source_transfers',
  'sms_reconciliation',
  'sms_candidates',
  'sms_sync_state',
  'transaction_links',
  'transaction_split_members',
  'transaction_split_groups',
  'attachments',
  'emi_installments',
  'emi_plans',
  'loan_commitments',
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
  private writeQueue: Promise<void> = Promise.resolve();
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
      const existingSchema =
        currentVersion === 0
          ? await CapacitorSQLite.query({
              database: this.databaseName,
              statement: `SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN (${BACKUP_TABLES.map((name) => `'${name}'`).join(',')})`,
              values: [],
            })
          : null;
      const noPreviousAppSchema = Number(existingSchema?.values?.[0]?.['count'] ?? -1) === 0;
      for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version > currentVersion)) {
        await CapacitorSQLite.execute({
          database: this.databaseName,
          statements: [...migration.statements, `PRAGMA user_version = ${migration.version};`].join(
            ';\n',
          ),
          transaction: true,
        });
      }
      // Versioned/partially populated installations are never eligible, even when cards are empty.
      let pristine = false;
      if (currentVersion === 0 && noPreviousAppSchema) {
        const rows = await CapacitorSQLite.query({
          database: this.databaseName,
          statement: `SELECT ${BACKUP_TABLES.map((name) => `(SELECT COUNT(*) FROM ${name})`).join('+')} AS count`,
          values: [],
        });
        pristine = Number(rows.values?.[0]?.['count'] ?? -1) === 0;
      }
      await CapacitorSQLite.run({
        database: this.databaseName,
        statement: 'INSERT OR IGNORE INTO app_preferences(key,encrypted_value) VALUES(?,?)',
        values: [INITIAL_DATA_KEY, pristine ? 'PENDING' : 'EXISTING'],
        transaction: false,
      });
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
    const operation = this.writeQueue.then(async () => {
      const result = await CapacitorSQLite.run({
        database: this.databaseName,
        statement,
        values: [...values],
        // A single SQLite statement is already atomic. jeep-sqlite cannot begin several
        // explicit transactions concurrently when signal effects persist in parallel.
        transaction: false,
      });
      if (this.isWeb) await CapacitorSQLite.saveToStore({ database: this.databaseName });
      return result.changes?.changes ?? 0;
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async exportBackupJson(): Promise<string> {
    if (!this.ready()) throw new Error('SQLite database is unavailable.');
    // The plugin's schema parser treats commas inside CHECK constraints as column
    // separators on web. Export rows directly so backups have the same stable format
    // on every platform and do not depend on re-parsing CREATE TABLE SQL.
    return this.exclusive(() => this.exportPortableBackupJson());
  }

  /** Shares the ledger write queue. Use only the supplied session inside work. */
  async atomic<T>(work: (session: DatabaseSession) => Promise<T>): Promise<T> {
    if (!this.ready()) throw new Error('SQLite database is unavailable.');
    const operation = this.writeQueue.then(async () => {
      await CapacitorSQLite.beginTransaction({ database: this.databaseName });
      const session: DatabaseSession = {
        query: async <R extends Record<string, unknown>>(
          statement: string,
          values: readonly unknown[] = [],
        ) => {
          const result = await CapacitorSQLite.query({
            database: this.databaseName,
            statement,
            values: [...values],
          });
          return (result.values ?? []) as readonly R[];
        },
        run: async (statement, values = []) => {
          const result = await CapacitorSQLite.run({
            database: this.databaseName,
            statement,
            values: [...values],
            transaction: false,
          });
          return result.changes?.changes ?? 0;
        },
      };
      let value: T;
      try {
        value = await work(session);
        await CapacitorSQLite.commitTransaction({ database: this.databaseName });
      } catch (error: unknown) {
        await CapacitorSQLite.rollbackTransaction({ database: this.databaseName });
        throw error;
      }
      if (this.isWeb) await CapacitorSQLite.saveToStore({ database: this.databaseName });
      return value;
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async restoreBackupJson(json: string): Promise<void> {
    await this.exclusive(async () => {
      await this.restoreBackupJsonUnqueued(json);
    });
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.writeQueue.then(work);
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async restoreBackupJsonUnqueued(json: string): Promise<void> {
    if (!this.ready()) throw new Error('SQLite database is unavailable.');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed['format'] === 'cardnest-portable-sqlite') {
      await this.restorePortableBackup(parsed);
      return;
    }
    this.repairLegacyPluginExport(parsed);
    parsed['database'] = this.databaseName;
    parsed['overwrite'] = true;
    parsed['encrypted'] = false;
    parsed['mode'] = 'full';
    const jsonstring = JSON.stringify(parsed);
    const validation = await CapacitorSQLite.isJsonValid({ jsonstring });
    if (!validation.result) throw new Error('The backup database is invalid.');
    await clearPlatformDiscovery();

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
    // The legacy importer closes its temporary connection. Reopen and migrate before
    // persisting the restore marker or saving the web store.
    await this.initialise();
    if (!this.ready()) throw new Error('The restored database could not be opened.');
    await CapacitorSQLite.run({
      database: this.databaseName,
      statement: `INSERT INTO app_preferences(key,encrypted_value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value`,
      values: [INITIAL_DATA_KEY, 'RESTORED'],
      transaction: false,
    });
    if (this.isWeb) await CapacitorSQLite.saveToStore({ database: this.databaseName });
  }

  private repairLegacyPluginExport(value: Record<string, unknown>): void {
    if (!Array.isArray(value['tables'])) return;

    for (const table of value['tables']) {
      if (!this.isRecord(table) || table['name'] !== 'credit_cards') continue;
      if (!Array.isArray(table['schema']) || !Array.isArray(table['values'])) continue;

      const schema = table['schema'];
      const lastDigitsIndex = schema.findIndex(
        (entry) => this.isRecord(entry) && entry['column'] === 'last_digits',
      );
      const phantomColumnIndex = schema.findIndex(
        (entry) => this.isRecord(entry) && entry['column'] === '5' && entry['value'] === '(4, 5))',
      );
      const rowsHaveExpectedLength = table['values'].every(
        (row) => Array.isArray(row) && row.length === schema.length - 1,
      );
      if (lastDigitsIndex < 0 || phantomColumnIndex < 0 || !rowsHaveExpectedLength) continue;

      const lastDigitsSchema = schema[lastDigitsIndex];
      if (!this.isRecord(lastDigitsSchema)) continue;
      lastDigitsSchema['value'] = 'TEXT NOT NULL CHECK(length(last_digits) IN (4, 5))';
      table['schema'] = schema.filter((_, index) => index !== phantomColumnIndex);
    }
  }

  async deleteAllData(): Promise<void> {
    await this.exclusive(async () => {
      await clearPlatformDiscovery();
      await this.deleteAllDataUnqueued();
    });
  }

  private async deleteAllDataUnqueued(): Promise<void> {
    if (!this.ready()) throw new Error('SQLite database is unavailable.');
    await CapacitorSQLite.execute({
      database: this.databaseName,
      transaction: true,
      statements: [
        ...DELETE_TABLES.map((table) => `DELETE FROM ${table}`),
        `INSERT INTO app_preferences VALUES ('${INITIAL_DATA_KEY}','CLEARED')`,
      ].join(';\n'),
    });
    if (this.isWeb) await CapacitorSQLite.saveToStore({ database: this.databaseName });
  }

  async deleteDataOlderThan(cutoffIso: string): Promise<number> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffIso)) throw new Error('Invalid retention date.');
    return this.exclusive(() => this.deleteDataOlderThanUnqueued(cutoffIso));
  }

  private async deleteDataOlderThanUnqueued(cutoffIso: string): Promise<number> {
    if (!this.ready()) throw new Error('SQLite database is unavailable.');
    await prunePlatformDiscovery(cutoffIso);
    const countResult = await CapacitorSQLite.query({
      database: this.databaseName,
      statement: 'SELECT COUNT(*) AS count FROM card_transactions WHERE transaction_date < ?',
      values: [cutoffIso],
    });
    const removed = Number(countResult.values?.[0]?.['count'] ?? 0);
    await CapacitorSQLite.execute({
      database: this.databaseName,
      transaction: true,
      statements: `
        UPDATE sms_candidates SET payload = NULL WHERE event_at < '${cutoffIso}';
        INSERT INTO sms_sync_state(key,value) VALUES ('retention_cutoff','${cutoffIso}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
        DELETE FROM transaction_links
         WHERE transaction_id IN (SELECT id FROM card_transactions WHERE transaction_date < '${cutoffIso}')
            OR related_transaction_id IN (SELECT id FROM card_transactions WHERE transaction_date < '${cutoffIso}');
        DELETE FROM transaction_split_members
         WHERE transaction_id IN (SELECT id FROM card_transactions WHERE transaction_date < '${cutoffIso}');
        DELETE FROM emi_installments
         WHERE emi_plan_id IN (
           SELECT id FROM emi_plans
            WHERE transaction_id IN (SELECT id FROM card_transactions WHERE transaction_date < '${cutoffIso}')
         );
        DELETE FROM emi_plans
         WHERE transaction_id IN (SELECT id FROM card_transactions WHERE transaction_date < '${cutoffIso}');
        DELETE FROM attachments
         WHERE transaction_id IN (SELECT id FROM card_transactions WHERE transaction_date < '${cutoffIso}');
        DELETE FROM source_transfers WHERE transfer_date < '${cutoffIso}';
        DELETE FROM card_transactions WHERE transaction_date < '${cutoffIso}';
        DELETE FROM transaction_split_groups
         WHERE id NOT IN (SELECT DISTINCT group_id FROM transaction_split_members);
        DELETE FROM statements WHERE cycle_end_date < '${cutoffIso}';
        DELETE FROM monthly_income WHERE cycle_end_date < '${cutoffIso}';
      `,
    });
    if (this.isWeb) await CapacitorSQLite.saveToStore({ database: this.databaseName });
    return removed;
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
        statement:
          name === 'sms_candidates'
            ? `SELECT id, provider_id, event_at, kind, state, NULL AS payload, transaction_id, updated_at, decision, read_at, received_at FROM sms_candidates`
            : `SELECT * FROM ${name}`,
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

    await clearPlatformDiscovery();
    await CapacitorSQLite.beginTransaction({ database: this.databaseName });
    try {
      await CapacitorSQLite.execute({
        database: this.databaseName,
        transaction: false,
        statements: DELETE_TABLES.map((table) => `DELETE FROM ${table}`).join(';\n'),
      });
      let pendingInserts: { statement: string; values: unknown[] }[] = [];
      const flushInserts = async () => {
        if (!pendingInserts.length) return;
        await CapacitorSQLite.executeSet({
          database: this.databaseName,
          set: pendingInserts,
          transaction: false,
        });
        pendingInserts = [];
      };
      for (const table of BACKUP_TABLES) {
        for (const original of backupTables.get(table) ?? []) {
          const row =
            table === 'sms_candidates' && !('read_at' in original)
              ? {
                  ...original,
                  read_at: ['IMPORTED', 'MATCHED_EXISTING', 'REJECTED', 'IGNORED'].includes(
                    String(original['state']),
                  )
                    ? original['updated_at']
                    : null,
                }
              : original;
          const columns = Object.keys(row);
          if (!columns.length || columns.some((column) => !/^[a-z][a-z0-9_]*$/i.test(column))) {
            throw new Error('The backup database contains invalid columns.');
          }
          pendingInserts.push({
            statement: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
            values: columns.map((column) => row[column]),
          });
          if (pendingInserts.length >= 250) await flushInserts();
        }
      }
      await flushInserts();
      await reconcileCategoryCatalog({
        query: async <T extends Record<string, unknown>>(
          statement: string,
          values: readonly unknown[] = [],
        ) => {
          const result = await CapacitorSQLite.query({
            database: this.databaseName,
            statement,
            values: [...values],
          });
          return (result.values ?? []) as T[];
        },
        run: async (statement, values = []) => {
          const result = await CapacitorSQLite.run({
            database: this.databaseName,
            statement,
            values: [...values],
            transaction: false,
          });
          return result.changes?.changes ?? 0;
        },
      });
      await CapacitorSQLite.execute({
        database: this.databaseName,
        transaction: false,
        statements: `${CLASSIFY_LEGACY_ADJUSTMENTS};
        UPDATE transaction_split_groups SET anchor_transaction_id=(SELECT transaction_id FROM transaction_split_members WHERE group_id=transaction_split_groups.id ORDER BY transaction_id LIMIT 1) WHERE anchor_transaction_id IS NULL;
        UPDATE transaction_split_groups SET currency_code=COALESCE((SELECT currency_code FROM card_transactions WHERE id=anchor_transaction_id),'INR'),updated_at=created_at WHERE updated_at='';`,
      });
      await CapacitorSQLite.run({
        database: this.databaseName,
        statement: `INSERT INTO app_preferences(key,encrypted_value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value`,
        values: [INITIAL_DATA_KEY, 'RESTORED'],
        transaction: false,
      });
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
