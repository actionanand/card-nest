export interface DatabaseMigration {
  readonly version: number;
  readonly statements: readonly string[];
}

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS app_preferences (key TEXT PRIMARY KEY NOT NULL, encrypted_value TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS credit_cards (id TEXT PRIMARY KEY NOT NULL, nickname TEXT NOT NULL, issuer_name TEXT NOT NULL, last_four_digits TEXT NOT NULL CHECK(length(last_four_digits) = 4), encrypted_full_number TEXT, network TEXT NOT NULL, payload TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL COLLATE NOCASE UNIQUE, icon TEXT NOT NULL, colour TEXT, applies_to TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS card_transactions (id TEXT PRIMARY KEY NOT NULL, card_id TEXT, category_id TEXT NOT NULL, type TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0), currency_code TEXT NOT NULL, transaction_date TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(card_id) REFERENCES credit_cards(id) ON DELETE SET NULL, FOREIGN KEY(category_id) REFERENCES categories(id))`,
      `CREATE TABLE IF NOT EXISTS statements (id TEXT PRIMARY KEY NOT NULL, card_id TEXT NOT NULL, cycle_start_date TEXT NOT NULL, cycle_end_date TEXT NOT NULL, statement_date TEXT NOT NULL, due_date TEXT NOT NULL, payload TEXT NOT NULL, FOREIGN KEY(card_id) REFERENCES credit_cards(id) ON DELETE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS recurring_rules (id TEXT PRIMARY KEY NOT NULL, card_id TEXT NOT NULL, next_occurrence_date TEXT, status TEXT NOT NULL, payload TEXT NOT NULL, FOREIGN KEY(card_id) REFERENCES credit_cards(id) ON DELETE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY NOT NULL, transaction_id TEXT NOT NULL, private_path TEXT NOT NULL, encrypted_metadata TEXT NOT NULL, FOREIGN KEY(transaction_id) REFERENCES card_transactions(id) ON DELETE CASCADE)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_card_date ON card_transactions(card_id, transaction_date)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_category ON card_transactions(category_id)`,
      `CREATE INDEX IF NOT EXISTS idx_statements_card_cycle ON statements(card_id, cycle_start_date, cycle_end_date)`,
      `CREATE INDEX IF NOT EXISTS idx_recurring_next ON recurring_rules(status, next_occurrence_date)`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS emi_plans (id TEXT PRIMARY KEY NOT NULL, transaction_id TEXT NOT NULL UNIQUE, card_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, FOREIGN KEY(transaction_id) REFERENCES card_transactions(id) ON DELETE CASCADE, FOREIGN KEY(card_id) REFERENCES credit_cards(id) ON DELETE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS emi_installments (id TEXT PRIMARY KEY NOT NULL, emi_plan_id TEXT NOT NULL, installment_number INTEGER NOT NULL, statement_date TEXT NOT NULL, due_date TEXT NOT NULL, principal_minor INTEGER NOT NULL, interest_minor INTEGER NOT NULL, paid INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, FOREIGN KEY(emi_plan_id) REFERENCES emi_plans(id) ON DELETE CASCADE, UNIQUE(emi_plan_id, installment_number))`,
      `CREATE INDEX IF NOT EXISTS idx_emi_card_status ON emi_plans(card_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_emi_due ON emi_installments(due_date, paid)`,
    ],
  },
];
