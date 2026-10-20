import type { SqliteDatabase } from './sqlite-database';
import type { Category, CreditCard, CardTransaction, MonthlyIncomeRecord } from '../models/domain';

export const INITIAL_DATA_KEY = 'initial_data_state';

/** Only the gateway may issue PENDING, after recognizing a pristine version-zero database. */
export async function initialiseAppData(
  database: Pick<SqliteDatabase, 'atomic'>,
  demo: boolean,
  data: {
    categories: readonly Category[];
    cards: readonly CreditCard[];
    transactions: readonly CardTransaction[];
    income: MonthlyIncomeRecord;
  },
): Promise<void> {
  await database.atomic(async (tx) => {
    const [marker] = await tx.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key=?',
      [INITIAL_DATA_KEY],
    );
    if (marker?.encrypted_value !== 'PENDING') return;
    // A failed first-run transaction may have been followed by explicit user activity.
    // Treat that installation as existing; never add demos over subsequently entered data.
    const [existing] = await tx.query<{ count: number }>(
      `SELECT ${['credit_cards', 'card_transactions', 'monthly_income', 'categories', 'loan_commitments', 'statements', 'recurring_rules', 'emi_plans', 'sms_candidates', 'sms_sync_state'].map((name) => `(SELECT COUNT(*) FROM ${name})`).join('+')} +
       (SELECT COUNT(*) FROM app_preferences WHERE key IN ('payment_sources','monthly_budget_minor','profile_name','profile_title','budget_cycle_start_day','data_cleared')) AS count`,
    );
    if (existing.count > 0) {
      await tx.run('UPDATE app_preferences SET encrypted_value=? WHERE key=?', [
        'EXISTING',
        INITIAL_DATA_KEY,
      ]);
      return;
    }
    for (const category of data.categories) {
      await tx.run(
        'INSERT INTO categories(id,name,icon,colour,applies_to,archived) VALUES(?,?,?,?,?,?)',
        [
          category.id,
          category.name,
          category.icon,
          category.colour ?? null,
          category.appliesTo,
          category.archived ? 1 : 0,
        ],
      );
    }
    if (demo) {
      for (const sample of data.cards) {
        const card = { ...sample, nickname: `${sample.nickname} (demo)` };
        await tx.run(
          `INSERT INTO credit_cards(id,nickname,issuer_name,last_digits,network,payload,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
          [
            card.id,
            card.nickname,
            card.issuerName,
            card.lastDigits,
            card.network,
            JSON.stringify(card),
            0,
            card.createdAt,
            card.updatedAt,
          ],
        );
      }
      for (const sample of data.transactions) {
        const item = { ...sample, merchant: `${sample.merchant ?? sample.type} (demo)` };
        await tx.run(
          `INSERT INTO card_transactions(id,card_id,category_id,type,amount_minor,currency_code,transaction_date,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          [
            item.id,
            item.cardId,
            item.categoryId,
            item.type,
            item.amountMinor,
            item.currencyCode,
            item.transactionDate,
            JSON.stringify(item),
            item.createdAt,
            item.updatedAt,
          ],
        );
      }
      const income = data.income;
      await tx.run('INSERT INTO monthly_income VALUES(?,?,?,?,?)', [
        income.periodKey,
        income.cycleStartDate,
        income.cycleEndDate,
        income.amountMinor,
        income.updatedAt,
      ]);
      await tx.run('INSERT INTO app_preferences VALUES(?,?)', ['monthly_budget_minor', '6000000']);
    }
    await tx.run('UPDATE app_preferences SET encrypted_value=? WHERE key=?', [
      demo ? 'DEMO' : 'EMPTY',
      INITIAL_DATA_KEY,
    ]);
  });
}
