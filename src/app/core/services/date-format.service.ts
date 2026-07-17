import { Pipe, PipeTransform, Service, inject, signal } from '@angular/core';
import { SqliteDatabase } from '../data/sqlite-database';

export type AppDateFormat =
  'DD-MM-YYYY' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'MMM-DD-YYYY' | 'DD-MMM-YYYY';

const DATE_FORMAT_KEY = 'display_date_format';
const DEFAULT_DATE_FORMAT: AppDateFormat = 'DD-MM-YYYY';

@Service()
export class DateFormatService {
  private readonly database = inject(SqliteDatabase);
  readonly formatPreference = signal<AppDateFormat>(DEFAULT_DATE_FORMAT);
  readonly options: readonly { value: AppDateFormat; label: string }[] = [
    { value: 'DD-MM-YYYY', label: 'DD-MM-YYYY — 15-01-2026' },
    { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY — 15/01/2026' },
    { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY — 01/15/2026' },
    { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD — 2026-01-15' },
    { value: 'MMM-DD-YYYY', label: 'MMM-DD-YYYY — Jan-15-2026' },
    { value: 'DD-MMM-YYYY', label: 'DD-MMM-YYYY — 15-Jan-2026' },
  ];

  async initialise(): Promise<void> {
    if (!this.database.ready()) return;
    const rows = await this.database.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key = ?',
      [DATE_FORMAT_KEY],
    );
    const stored = rows[0]?.encrypted_value;
    if (this.isDateFormat(stored)) this.formatPreference.set(stored);
  }

  async setFormat(value: AppDateFormat): Promise<void> {
    this.formatPreference.set(value);
    if (!this.database.ready()) return;
    await this.database.run(
      `INSERT INTO app_preferences (key, encrypted_value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value`,
      [DATE_FORMAT_KEY, value],
    );
  }

  format(value: string | Date | null | undefined): string {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(`${value.slice(0, 10)}T12:00:00`);
    if (Number.isNaN(date.getTime())) return String(value);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());
    const monthName = date.toLocaleDateString('en-IN', { month: 'short' });
    switch (this.formatPreference()) {
      case 'DD/MM/YYYY':
        return `${day}/${month}/${year}`;
      case 'MM/DD/YYYY':
        return `${month}/${day}/${year}`;
      case 'YYYY-MM-DD':
        return `${year}-${month}-${day}`;
      case 'MMM-DD-YYYY':
        return `${monthName}-${day}-${year}`;
      case 'DD-MMM-YYYY':
        return `${day}-${monthName}-${year}`;
      default:
        return `${day}-${month}-${year}`;
    }
  }

  private isDateFormat(value: string | undefined): value is AppDateFormat {
    return this.options.some((option) => option.value === value);
  }
}

@Pipe({ name: 'appDate', pure: false })
export class AppDatePipe implements PipeTransform {
  private readonly dates = inject(DateFormatService);

  transform(value: string | Date | null | undefined): string {
    return this.dates.format(value);
  }
}
