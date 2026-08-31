import { Service, inject, signal } from '@angular/core';
import { SqliteDatabase } from '../data/sqlite-database';

const EXPIRY_FIRST_DAY_KEY = 'card_expiry_first_day';

export function cardExpiryDate(
  expiryYear: number,
  expiryMonth: number,
  useFirstDay: boolean,
): Date {
  return useFirstDay
    ? new Date(expiryYear, expiryMonth - 1, 1, 23, 59, 59, 999)
    : new Date(expiryYear, expiryMonth, 0, 23, 59, 59, 999);
}

@Service()
export class CardExpiryService {
  private readonly database = inject(SqliteDatabase);
  readonly useFirstDay = signal(true);

  async initialise(): Promise<void> {
    if (!this.database.ready()) return;
    const rows = await this.database.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key = ?',
      [EXPIRY_FIRST_DAY_KEY],
    );
    const stored = rows[0]?.encrypted_value;
    if (stored !== undefined) this.useFirstDay.set(stored !== '0');
  }

  async setUseFirstDay(enabled: boolean): Promise<void> {
    this.useFirstDay.set(enabled);
    if (!this.database.ready()) return;
    await this.database.run(
      `INSERT INTO app_preferences (key, encrypted_value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value`,
      [EXPIRY_FIRST_DAY_KEY, enabled ? '1' : '0'],
    );
  }

  date(expiryYear: number, expiryMonth: number): Date {
    return cardExpiryDate(expiryYear, expiryMonth, this.useFirstDay());
  }
}
