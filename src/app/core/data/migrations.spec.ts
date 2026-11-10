import { DATABASE_MIGRATIONS } from './migrations';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

describe('SMS upgrade of an existing version-6 database', () => {
  it('adds consumer-wallet tables to schema v14 without changing source preferences', () => {
    const sql = new DatabaseSync(':memory:');
    try {
      sql.exec('PRAGMA foreign_keys=ON');
      for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version < 15))
        for (const statement of migration.statements) sql.exec(statement);
      sql.exec(
        "INSERT INTO app_preferences VALUES('payment_sources','FASTAG_AND_PLUXEE_UNCHANGED');PRAGMA user_version=14",
      );
      for (const statement of DATABASE_MIGRATIONS.find((item) => item.version === 15)!.statements)
        sql.exec(statement);

      const tables = sql
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'consumer_wallet%' ORDER BY name",
        )
        .all()
        .map((row) => String(row['name']));
      expect(tables).toEqual([
        'consumer_wallet_event_allocations',
        'consumer_wallet_events',
        'consumer_wallets',
      ]);
      expect(
        sql
          .prepare("SELECT encrypted_value FROM app_preferences WHERE key='payment_sources'")
          .get()?.['encrypted_value'],
      ).toBe('FASTAG_AND_PLUXEE_UNCHANGED');

      sql.exec(`
        INSERT INTO consumer_wallets(id,provider_id,wallet_kind,archived,payload,created_at,updated_at)
          VALUES('wallet','amazon-pay','STANDARD',0,'{}','now','now');
        INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,payload,created_at,updated_at)
          VALUES('credit','wallet','MANUAL_CREDIT','2026-11-01',5000,5000,'{}','now','now');
        INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,payload,created_at,updated_at)
          VALUES('debit','wallet','PURCHASE','2026-11-02',1000,-1000,'{}','now','now');
        INSERT INTO consumer_wallet_event_allocations(id,debit_event_id,credit_event_id,allocated_minor,created_at)
          VALUES('allocation','debit','credit',1000,'now');
      `);
      expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() => sql.exec("DELETE FROM consumer_wallets WHERE id='wallet'")).toThrow();
      expect(() => sql.exec("DELETE FROM consumer_wallet_events WHERE id='credit'")).toThrow();
      expect(
        sql.prepare('SELECT allocated_minor FROM consumer_wallet_event_allocations').get()?.[
          'allocated_minor'
        ],
      ).toBe(1000);
    } finally {
      sql.close();
    }
  });

  it('adds funded-load provenance and uniqueness constraints in schema v16', () => {
    const sql = new DatabaseSync(':memory:');
    try {
      sql.exec('PRAGMA foreign_keys=ON');
      for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 15))
        for (const statement of migration.statements) sql.exec(statement);
      sql.exec(`
        INSERT INTO consumer_wallets(id,provider_id,wallet_kind,archived,payload,created_at,updated_at)
          VALUES('wallet','amazon-pay','STANDARD',0,'{}','now','now');
        INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,funding_source_kind,funding_source_id,source_transaction_id,payload,created_at,updated_at)
          VALUES('load','wallet','FUNDED_LOAD','2026-10-01',30000,30000,'CARD','card','debit','{}','now','now');
      `);
      for (const statement of DATABASE_MIGRATIONS.find((item) => item.version === 16)!.statements)
        sql.exec(statement);
      expect(
        sql
          .prepare(
            'SELECT debit_amount_minor,funding_category_id FROM consumer_wallet_events WHERE id=?',
          )
          .get('load'),
      ).toMatchObject({ debit_amount_minor: null, funding_category_id: null });
      sql.exec(
        "UPDATE consumer_wallet_events SET debit_amount_minor=32000,funding_category_id='other',event_time='10:30' WHERE id='load'",
      );
      expect(() =>
        sql.exec(
          "INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,source_transaction_id,payload,created_at,updated_at) VALUES('duplicate-load','wallet','FUNDED_LOAD','2026-10-01',30000,30000,'debit','{}','later','later')",
        ),
      ).toThrow();
      sql.exec(
        "INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,source_transaction_id,payload,created_at,updated_at) VALUES('purchase','wallet','PURCHASE','2026-10-02',1000,-1000,'debit','{}','later','later')",
      );
      expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      sql.close();
    }
  });

  it('adds return, refund provenance, expense reversal and typed wallet split tables in schema v17', () => {
    const sql = new DatabaseSync(':memory:');
    try {
      sql.exec('PRAGMA foreign_keys=ON');
      for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 16))
        for (const statement of migration.statements) sql.exec(statement);
      sql.exec(`
        INSERT INTO consumer_wallets(id,provider_id,wallet_kind,archived,payload,created_at,updated_at)
          VALUES('upi','upi-lite','UPI_LITE',0,'{}','now','now');
        INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,payload,created_at,updated_at)
          VALUES('load','upi','FUNDED_LOAD','2026-11-01',50000,50000,'{}','load','load');
        INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,payload,created_at,updated_at)
          VALUES('return','upi','UPI_LITE_RETURN','2026-11-03',10000,-10000,'{}','return','return');
        INSERT INTO transaction_split_groups(id,original_amount_minor,created_at,kind,anchor_transaction_id,title,currency_code,bill_total_minor,updated_at)
          VALUES('group',10000,'now','PAYMENTS',NULL,'Mixed','INR',10000,'now');
      `);
      for (const statement of DATABASE_MIGRATIONS.find((item) => item.version === 17)!.statements)
        sql.exec(statement);
      sql.exec(`
        INSERT INTO consumer_wallet_return_links(return_event_id,wallet_id,bank_source_id,created_at)
          VALUES('return','upi','bank-1','now');
        INSERT INTO consumer_wallet_credit_provenance(credit_event_id,source_credit_event_id,allocated_minor,created_at)
          VALUES('return','load',10000,'now');
        INSERT INTO consumer_wallet_expense_reversals(return_event_id,credit_event_id,funded_load_event_id,reversed_minor,created_at)
          VALUES('return','load','load',10000,'now');
        INSERT INTO consumer_wallet_split_members(group_id,wallet_event_id,member_kind,member_order,created_at)
          VALUES('group','return','WALLET_REFUND',1,'now');
      `);
      expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() =>
        sql.exec(
          "INSERT INTO consumer_wallet_return_links(return_event_id,wallet_id,bank_source_id,existing_bank_transaction_id,created_at) VALUES('return','upi','bank-1','bank-credit','later')",
        ),
      ).toThrow();
      expect(() =>
        sql.exec(
          "INSERT INTO consumer_wallet_split_members(group_id,wallet_event_id,member_kind,member_order,created_at) VALUES('group','return','WALLET_PURCHASE',2,'later')",
        ),
      ).toThrow();
    } finally {
      sql.close();
    }
  });

  it('retains the additive v17 wallet return, refund provenance and typed split schema', () => {
    const sql = new DatabaseSync(':memory:');
    try {
      sql.exec('PRAGMA foreign_keys=ON');
      for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 16))
        for (const statement of migration.statements) sql.exec(statement);
      sql.exec(`
        INSERT INTO consumer_wallets(id,provider_id,wallet_kind,archived,payload,created_at,updated_at)
          VALUES('upi','upi-lite','UPI_LITE',0,'{}','now','now');
        INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,payload,created_at,updated_at)
          VALUES('load','upi','FUNDED_LOAD','2026-11-01',50000,50000,'{}','load','load');
        INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,payload,created_at,updated_at)
          VALUES('return','upi','UPI_LITE_RETURN','2026-11-03',10000,-10000,'{}','return','return');
        INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,payload,created_at,updated_at)
          VALUES('return-2','upi','UPI_LITE_RETURN','2026-11-04',10000,-10000,'{}','return-2','return-2');
        INSERT INTO transaction_split_groups(id,original_amount_minor,created_at,kind,anchor_transaction_id,title,currency_code,bill_total_minor,updated_at)
          VALUES('group',10000,'now','PAYMENTS',NULL,'Mixed','INR',10000,'now');
      `);
      for (const statement of DATABASE_MIGRATIONS.find((item) => item.version === 17)!.statements)
        sql.exec(statement);
      sql.exec(`
        INSERT INTO consumer_wallet_return_links(return_event_id,wallet_id,bank_source_id,existing_bank_transaction_id,created_at)
          VALUES('return','upi','bank-1','bank-credit','now');
        INSERT INTO consumer_wallet_credit_provenance(credit_event_id,source_credit_event_id,allocated_minor,created_at)
          VALUES('return','load',10000,'now');
        INSERT INTO consumer_wallet_expense_reversals(return_event_id,credit_event_id,funded_load_event_id,reversed_minor,created_at)
          VALUES('return','return','load',10000,'now');
        INSERT INTO consumer_wallet_split_members(group_id,wallet_event_id,member_kind,member_order,created_at)
          VALUES('group','return','WALLET_REFUND',1,'now');
      `);
      expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() =>
        sql.exec(
          "INSERT INTO consumer_wallet_return_links(return_event_id,wallet_id,bank_source_id,existing_bank_transaction_id,created_at) VALUES('return-2','upi','bank-1','bank-credit','later')",
        ),
      ).toThrow();
      expect(() =>
        sql.exec(
          "INSERT INTO consumer_wallet_split_members(group_id,wallet_event_id,member_kind,member_order,created_at) VALUES('group','return','WALLET_PURCHASE',2,'later')",
        ),
      ).toThrow();
    } finally {
      sql.close();
    }
  });

  it('adds ordered wallet refund provenance segments and backfills only provable single-root rows', () => {
    const sql = new DatabaseSync(':memory:');
    try {
      sql.exec('PRAGMA foreign_keys=ON');
      for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 16))
        for (const statement of migration.statements) sql.exec(statement);
      sql.exec(`
        INSERT INTO consumer_wallets(id,provider_id,wallet_kind,archived,payload,created_at,updated_at)
          VALUES('wallet','amazon-pay','STANDARD',0,'{}','now','now');
        INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,reversal_of_event_id,payload,created_at,updated_at)
          VALUES('root','wallet','PROMOTIONAL_CREDIT','2026-10-01',10000,10000,NULL,'{}','root','root');
        INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,reversal_of_event_id,payload,created_at,updated_at)
          VALUES('purchase','wallet','PURCHASE','2026-10-02',10000,-10000,NULL,'{}','purchase','purchase');
        INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,reversal_of_event_id,payload,created_at,updated_at)
          VALUES('legacy-single-refund','wallet','REFUND','2026-10-03',10000,10000,'purchase','{}','single','single');
        INSERT INTO consumer_wallet_events(id,wallet_id,event_type,event_date,amount_minor,balance_delta_minor,reversal_of_event_id,payload,created_at,updated_at)
          VALUES('legacy-multi-refund','wallet','REFUND','2026-10-04',10000,10000,'purchase','{}','multi','multi');
      `);
      for (const statement of DATABASE_MIGRATIONS.find((item) => item.version === 17)!.statements)
        sql.exec(statement);
      sql.exec(`
        INSERT INTO consumer_wallet_credit_provenance(credit_event_id,source_credit_event_id,allocated_minor,created_at)
          VALUES('legacy-single-refund','root',10000,'now');
        INSERT INTO consumer_wallet_credit_provenance(credit_event_id,source_credit_event_id,allocated_minor,created_at)
          VALUES('legacy-multi-refund','root',6000,'now');
        INSERT INTO consumer_wallet_credit_provenance(credit_event_id,source_credit_event_id,allocated_minor,created_at)
          VALUES('legacy-multi-refund','purchase',4000,'now');
      `);
      for (const statement of DATABASE_MIGRATIONS.find((item) => item.version === 18)!.statements)
        sql.exec(statement);
      expect(
        sql
          .prepare(
            'SELECT credit_event_id,segment_order,root_credit_event_id,source_purchase_event_id,amount_minor FROM consumer_wallet_credit_provenance_segments ORDER BY credit_event_id,segment_order',
          )
          .all(),
      ).toEqual([
        {
          credit_event_id: 'legacy-single-refund',
          segment_order: 0,
          root_credit_event_id: 'root',
          source_purchase_event_id: 'purchase',
          amount_minor: 10000,
        },
      ]);
      expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() =>
        sql.exec(
          "INSERT INTO consumer_wallet_credit_provenance_segments(id,credit_event_id,segment_order,root_credit_event_id,source_purchase_event_id,amount_minor,created_at) VALUES('duplicate-order','legacy-single-refund',0,'root','purchase',1000,'later')",
        ),
      ).toThrow();
    } finally {
      sql.close();
    }
  });

  it('adds portable TV profile and recharge tables without altering wallet schema', () => {
    const sql = new DatabaseSync(':memory:');
    try {
      sql.exec('PRAGMA foreign_keys=ON');
      for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version < 19))
        for (const statement of migration.statements) sql.exec(statement);
      sql.exec('PRAGMA user_version=18');
      const migration = DATABASE_MIGRATIONS.find((item) => item.version === 19)!;
      for (const statement of migration.statements) sql.exec(statement);
      sql.exec(`
        INSERT INTO tv_profiles(id,provider,archived,payload,created_at,updated_at)
          VALUES('tv-profile','OTHER',0,'{}','now','now');
        INSERT INTO tv_recharges(id,profile_id,start_date,end_date,amount_minor,payload,created_at,updated_at)
          VALUES('tv-recharge','tv-profile','2026-11-01','2026-11-30',25000,'{}','now','now');
      `);
      expect(sql.prepare('SELECT provider FROM tv_profiles WHERE id=?').get('tv-profile')).toEqual({
        provider: 'OTHER',
      });
      expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(DATABASE_MIGRATIONS.at(-1)?.version).toBe(19);
    } finally {
      sql.close();
    }
  });

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
