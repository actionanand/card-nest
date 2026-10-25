export interface DatabaseMigration {
  readonly version: number;
  readonly statements: readonly string[];
}

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS app_preferences (key TEXT PRIMARY KEY NOT NULL, encrypted_value TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS credit_cards (id TEXT PRIMARY KEY NOT NULL, nickname TEXT NOT NULL, issuer_name TEXT NOT NULL, last_digits TEXT NOT NULL CHECK(length(last_digits) IN (4, 5)), encrypted_full_number TEXT, network TEXT NOT NULL, payload TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
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
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS monthly_income (period_key TEXT PRIMARY KEY NOT NULL, cycle_start_date TEXT NOT NULL, cycle_end_date TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0), updated_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_monthly_income_cycle_start ON monthly_income(cycle_start_date DESC)`,
    ],
  },
  {
    version: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS category_limits (category_id TEXT PRIMARY KEY NOT NULL, limit_minor INTEGER NOT NULL CHECK(limit_minor >= 0), show_limit INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS card_benefits (id TEXT PRIMARY KEY NOT NULL, card_id TEXT NOT NULL, name TEXT NOT NULL, note TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(card_id) REFERENCES credit_cards(id) ON DELETE CASCADE)`,
      `CREATE INDEX IF NOT EXISTS idx_card_benefits_name ON card_benefits(name COLLATE NOCASE)`,
      `CREATE TABLE IF NOT EXISTS card_important_links (id TEXT PRIMARY KEY NOT NULL, card_id TEXT NOT NULL, label TEXT NOT NULL, url TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(card_id) REFERENCES credit_cards(id) ON DELETE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS card_relationship_groups (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS card_relationship_members (group_id TEXT NOT NULL, card_id TEXT NOT NULL UNIQUE, PRIMARY KEY(group_id, card_id), FOREIGN KEY(group_id) REFERENCES card_relationship_groups(id) ON DELETE CASCADE, FOREIGN KEY(card_id) REFERENCES credit_cards(id) ON DELETE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS card_secrets (card_id TEXT PRIMARY KEY NOT NULL, encrypted_number TEXT, encrypted_cvv TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(card_id) REFERENCES credit_cards(id) ON DELETE CASCADE)`,
    ],
  },
  {
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS transaction_links (transaction_id TEXT PRIMARY KEY NOT NULL, related_transaction_id TEXT NOT NULL, relationship_type TEXT NOT NULL CHECK(relationship_type IN ('REFUND', 'ADJUSTMENT')), created_at TEXT NOT NULL, FOREIGN KEY(transaction_id) REFERENCES card_transactions(id) ON DELETE CASCADE, FOREIGN KEY(related_transaction_id) REFERENCES card_transactions(id) ON DELETE CASCADE)`,
      `CREATE INDEX IF NOT EXISTS idx_transaction_links_related ON transaction_links(related_transaction_id)`,
      `CREATE TABLE IF NOT EXISTS transaction_split_groups (id TEXT PRIMARY KEY NOT NULL, original_amount_minor INTEGER NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS transaction_split_members (group_id TEXT NOT NULL, transaction_id TEXT NOT NULL UNIQUE, PRIMARY KEY(group_id, transaction_id), FOREIGN KEY(group_id) REFERENCES transaction_split_groups(id) ON DELETE CASCADE, FOREIGN KEY(transaction_id) REFERENCES card_transactions(id) ON DELETE CASCADE)`,
    ],
  },
  {
    version: 6,
    statements: [
      `CREATE TABLE IF NOT EXISTS loan_commitments (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_loan_commitments_status ON loan_commitments(status)`,
    ],
  },
  {
    version: 7,
    statements: [
      `CREATE TABLE IF NOT EXISTS sms_candidates (id TEXT PRIMARY KEY NOT NULL, provider_id TEXT NOT NULL, event_at TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','REJECTED','IGNORED','IMPORTED','MATCHED_EXISTING','DEFERRED','ERROR')), payload TEXT, transaction_id TEXT, updated_at TEXT NOT NULL, decision TEXT, FOREIGN KEY(transaction_id) REFERENCES card_transactions(id) ON DELETE SET NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_sms_review ON sms_candidates(state, event_at DESC)`,
      `CREATE TABLE IF NOT EXISTS sms_reconciliation (id TEXT PRIMARY KEY NOT NULL, candidate_id TEXT NOT NULL UNIQUE, target_id TEXT, decision TEXT NOT NULL, amount_minor INTEGER, created_at TEXT NOT NULL, FOREIGN KEY(candidate_id) REFERENCES sms_candidates(id) ON DELETE CASCADE)`,
      `CREATE TABLE IF NOT EXISTS sms_sync_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
    ],
  },
  {
    version: 8,
    statements: [
      `ALTER TABLE sms_candidates ADD COLUMN read_at TEXT`,
      `UPDATE sms_candidates SET read_at=updated_at WHERE state IN ('IMPORTED','MATCHED_EXISTING','REJECTED','IGNORED')`,
      `CREATE INDEX idx_sms_read ON sms_candidates(read_at,event_at DESC)`,
    ],
  },
  {
    version: 9,
    statements: [
      `CREATE TABLE IF NOT EXISTS source_transfers (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('TRANSFER','CASH_WITHDRAWAL','CASH_DEPOSIT','CARD_SETTLEMENT','LOAN_REPAYMENT')), from_source_id TEXT NOT NULL, to_source_id TEXT, payment_transaction_id TEXT UNIQUE, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), transfer_date TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK(to_source_id IS NULL OR to_source_id <> from_source_id), FOREIGN KEY(payment_transaction_id) REFERENCES card_transactions(id) ON DELETE CASCADE)`,
      `CREATE INDEX IF NOT EXISTS idx_source_transfers_date ON source_transfers(transfer_date DESC)`,
      `CREATE TABLE IF NOT EXISTS source_balance_adjustments (id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, reason TEXT NOT NULL, previous_minor INTEGER, new_minor INTEGER NOT NULL, correction_minor INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_source_balance_adjustments ON source_balance_adjustments(source_id, created_at DESC)`,
    ],
  },
  {
    version: 10,
    statements: [
      `CREATE TABLE IF NOT EXISTS utility_profiles (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('MOBILE','LPG')), archived INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_utility_profiles_kind ON utility_profiles(kind, archived)`,
      `CREATE TABLE IF NOT EXISTS mobile_recharges (id TEXT PRIMARY KEY NOT NULL, profile_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, plan_type TEXT NOT NULL CHECK(plan_type IN ('VOICE_DATA','VOICE_ONLY','DATA_ONLY')), amount_minor INTEGER, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES utility_profiles(id) ON DELETE CASCADE)`,
      `CREATE INDEX IF NOT EXISTS idx_mobile_recharges_profile_dates ON mobile_recharges(profile_id, start_date, end_date)`,
      `CREATE TABLE IF NOT EXISTS lpg_events (id TEXT PRIMARY KEY NOT NULL, profile_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('STARTED','EMPTY','REFILL_RECEIVED')), event_date TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES utility_profiles(id) ON DELETE CASCADE)`,
      `CREATE INDEX IF NOT EXISTS idx_lpg_events_profile_date ON lpg_events(profile_id, event_date)`,
      `CREATE TABLE IF NOT EXISTS bank_activity_profiles (id TEXT PRIMARY KEY NOT NULL, payment_source_id TEXT, bank_name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_activity_linked_source ON bank_activity_profiles(payment_source_id) WHERE payment_source_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS bank_activity_events (id TEXT PRIMARY KEY NOT NULL, profile_id TEXT NOT NULL, activity_date TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('CREDIT','DEBIT')), origin TEXT NOT NULL CHECK(origin IN ('MANUAL','ANDROID_SMS')), verification TEXT NOT NULL CHECK(verification IN ('USER_CONFIRMED','SOURCE_MATCHED')), fingerprint TEXT UNIQUE, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES bank_activity_profiles(id) ON DELETE CASCADE)`,
      `CREATE INDEX IF NOT EXISTS idx_bank_activity_events_profile_date ON bank_activity_events(profile_id, activity_date DESC)`,
    ],
  },
  {
    version: 11,
    statements: [
      `CREATE TABLE IF NOT EXISTS bank_activity_candidates (fingerprint TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_bank_activity_candidates_created ON bank_activity_candidates(created_at DESC)`,
    ],
  },
];
