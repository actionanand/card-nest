import { DATABASE_MIGRATIONS } from './migrations';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

describe('SMS upgrade of an existing version-6 database', () => {
  it('classifies historical adjustments only from positive audit provenance and preserves financial columns', () => {
    const sql = new DatabaseSync(':memory:');
    try {
      sql.exec('PRAGMA foreign_keys=ON');
      for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version < 12))
        for (const statement of migration.statements) sql.exec(statement);
      sql.exec(
        "INSERT INTO categories(id,name,icon,applies_to) VALUES('other','Other','test','BOTH');INSERT INTO app_preferences VALUES('payment_sources','UNCHANGED')",
      );
      const insert = sql.prepare(
        'INSERT INTO card_transactions(id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      );
      for (const [id, type, direction] of [
        ['purchase', 'PURCHASE', undefined],
        ['manual', 'ADJUSTMENT', 'DECREASE'],
        ['sms-adjustment-real', 'ADJUSTMENT', 'INCREASE'],
        ['sms-adjustment-ambiguous', 'ADJUSTMENT', 'INCREASE'],
      ] as const) {
        insert.run(
          id,
          'other',
          type,
          2000,
          'INR',
          '2026-10-26',
          JSON.stringify({
            id,
            type,
            cardId: 'meal',
            amountMinor: 2000,
            reference: 'PRESERVED',
            adjustmentDirection: direction,
            merchant: 'Approved wallet balance reconciliation',
          }),
          'before',
          'before',
        );
      }
      sql.exec(
        "INSERT INTO sms_candidates(id,provider_id,event_at,kind,state,transaction_id,updated_at,decision) VALUES('real','provider','2026-10-26','PLUXEE_PURCHASE','IMPORTED','purchase','before','ADJUST_BALANCE');INSERT INTO sms_reconciliation VALUES('audit','real','purchase','ADJUST_BALANCE',2000,'before');INSERT INTO transaction_links VALUES('sms-adjustment-real','purchase','ADJUSTMENT','before');INSERT INTO transaction_split_groups VALUES('legacy-division',4000,'before');INSERT INTO transaction_split_members VALUES('legacy-division','manual');INSERT INTO transaction_split_members VALUES('legacy-division','purchase')",
      );
      const snapshot = sql
        .prepare(
          'SELECT id,amount_minor,category_id,currency_code,created_at,updated_at FROM card_transactions ORDER BY id',
        )
        .all();
      for (const statement of DATABASE_MIGRATIONS.find((item) => item.version === 12)!.statements)
        sql.exec(statement);
      const payload = (id: string) =>
        JSON.parse(
          String(
            sql.prepare('SELECT payload FROM card_transactions WHERE id=?').get(id)?.['payload'],
          ),
        ) as Record<string, unknown>;
      expect(payload('manual')).toMatchObject({
        adjustmentPurpose: 'LEGACY_MANUAL',
        adjustmentDirection: 'DECREASE',
        reference: 'PRESERVED',
      });
      expect(payload('sms-adjustment-real')['adjustmentPurpose']).toBe('BALANCE_RECONCILIATION');
      expect(payload('sms-adjustment-ambiguous')['adjustmentPurpose']).toBe('LEGACY_MANUAL');
      expect(
        sql
          .prepare(
            'SELECT id,amount_minor,category_id,currency_code,created_at,updated_at FROM card_transactions ORDER BY id',
          )
          .all(),
      ).toEqual(snapshot);
      expect(sql.prepare('SELECT kind FROM transaction_split_groups').get()?.['kind']).toBe(
        'DIVISION',
      );
      expect(
        sql.prepare('SELECT encrypted_value FROM app_preferences').get()?.['encrypted_value'],
      ).toBe('UNCHANGED');
      expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      sql.close();
    }
  });
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
