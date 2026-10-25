import { DATABASE_MIGRATIONS } from './migrations';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

describe('SMS upgrade of an existing version-6 database', () => {
  it('adds Utilities and Bank Activity tables additively on top of schema v9', () => {
    const sql = new DatabaseSync(':memory:');
    try {
      sql.exec('PRAGMA foreign_keys=ON');
      for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 9))
        for (const statement of migration.statements) sql.exec(statement);
      sql.exec("INSERT INTO app_preferences VALUES ('bank_cash_tracking','{\"enabled\":true}')");
      sql.exec(
        "INSERT INTO source_transfers(id,kind,from_source_id,to_source_id,amount_minor,transfer_date,payload,created_at,updated_at) VALUES ('existing-transfer','TRANSFER','a','b',1,'2026-10-01','{}','before','before')",
      );
      const migration = DATABASE_MIGRATIONS.find((item) => item.version === 10)!;
      for (const statement of migration.statements) sql.exec(statement);
      const reviewQueueMigration = DATABASE_MIGRATIONS.find((item) => item.version === 11)!;
      for (const statement of reviewQueueMigration.statements) sql.exec(statement);
      sql.exec('PRAGMA user_version=11');
      expect(sql.prepare('PRAGMA user_version').get()?.['user_version']).toBe(11);
      expect(
        sql
          .prepare("SELECT encrypted_value FROM app_preferences WHERE key='bank_cash_tracking'")
          .get()?.['encrypted_value'],
      ).toBe('{"enabled":true}');
      expect(sql.prepare('SELECT id FROM source_transfers').get()?.['id']).toBe(
        'existing-transfer',
      );
      expect(
        sql
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('utility_profiles','mobile_recharges','lpg_events','bank_activity_profiles','bank_activity_events','bank_activity_candidates') ORDER BY name",
          )
          .all(),
      ).toHaveLength(6);
      expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      sql.close();
    }
  });

  it('preserves financial rows and preferences, supports replay, and enforces review constraints', () => {
    const sql = new DatabaseSync(':memory:');
    try {
      sql.exec('PRAGMA foreign_keys=ON');
      for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 6))
        for (const statement of migration.statements) sql.exec(statement);
      sql.exec(`
        PRAGMA user_version=6;
        INSERT INTO app_preferences VALUES ('payment-sources', '{"balanceMinor":123456}');
        INSERT INTO credit_cards(id,nickname,issuer_name,last_digits,network,payload,created_at,updated_at)
          VALUES ('fiction-card','Demo','AMEX','54321','AMERICAN_EXPRESS','{}','before','before');
        INSERT INTO categories(id,name,icon,applies_to) VALUES ('demo','Demo','test','BOTH');
        INSERT INTO card_transactions VALUES ('manual','fiction-card','demo','PURCHASE',1200,'INR','2026-10-01','{"manual":true}','before','before');
        INSERT INTO statements VALUES ('statement','fiction-card','2026-09-01','2026-09-30','2026-10-01','2026-10-20','{"dueMinor":1200}');
        INSERT INTO loan_commitments VALUES ('loan','ACTIVE','{"installmentMinor":30000}','before');
        INSERT INTO emi_plans VALUES ('plan','manual','fiction-card','ACTIVE','{}');
        INSERT INTO emi_installments VALUES ('installment','plan',1,'2026-10-01','2026-10-20',1000,200,0,'{}');
      `);
      const tables = sql
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((row) => String(row['name']));
      const snapshot = () =>
        tables.map((name) => ({ name, rows: sql.prepare(`SELECT * FROM ${name}`).all() }));
      const before = snapshot();
      const upgrade = DATABASE_MIGRATIONS.find((item) => item.version === 7);
      expect(upgrade).toBeDefined();
      for (let replay = 0; replay < 2; replay++) {
        sql.exec('BEGIN');
        for (const statement of upgrade!.statements) sql.exec(statement);
        sql.exec('PRAGMA user_version=7; COMMIT');
        expect(snapshot()).toEqual(before);
        expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      }
      expect(sql.prepare('PRAGMA user_version').get()?.['user_version']).toBe(7);
      sql.exec(
        "INSERT INTO sms_candidates VALUES ('synthetic','1','2026-10-01','BANK_DEBIT','PENDING',NULL,NULL,'now',NULL)",
      );
      expect(() =>
        sql.exec(
          "INSERT INTO sms_candidates VALUES ('synthetic','2','2026-10-01','BANK_DEBIT','PENDING',NULL,NULL,'now',NULL)",
        ),
      ).toThrow();
      expect(() => sql.exec("UPDATE sms_candidates SET state='APPROVED_WITHOUT_IMPORT'")).toThrow();
      expect(() => sql.exec("UPDATE sms_candidates SET transaction_id='missing'")).toThrow();
      expect(snapshot()).toEqual(before);
    } finally {
      sql.close();
    }
  });
});
