import { DOCUMENT } from '@angular/common';
import { inject, Service, signal } from '@angular/core';
import { SqliteDatabase } from '../data/sqlite-database';

export type AppTheme = 'SYSTEM' | 'LIGHT' | 'DARK';

interface AndroidSystemBars {
  setDarkMode(darkMode: boolean): void;
}

@Service()
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly database = inject(SqliteDatabase);
  readonly theme = signal<AppTheme>('SYSTEM');

  async initialise(): Promise<void> {
    if (!this.database.ready()) {
      this.applyTheme('SYSTEM');
      return;
    }

    const rows = await this.database.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key = ?',
      ['theme'],
    );
    const savedTheme = rows[0]?.encrypted_value;
    this.applyTheme(this.isTheme(savedTheme) ? savedTheme : 'SYSTEM');
  }

  async setTheme(theme: AppTheme): Promise<void> {
    this.applyTheme(theme);
    if (!this.database.ready()) return;
    await this.database.run(
      `INSERT INTO app_preferences (key, encrypted_value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value`,
      ['theme', theme],
    );
  }

  private applyTheme(theme: AppTheme): void {
    this.theme.set(theme);
    const root = this.document.documentElement;
    if (theme === 'SYSTEM') {
      delete root.dataset['theme'];
    } else {
      root.dataset['theme'] = theme;
    }

    const themeColour = this.document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const systemIsDark = this.document.defaultView?.matchMedia(
      '(prefers-color-scheme: dark)',
    ).matches;
    const darkMode = theme === 'DARK' || (theme === 'SYSTEM' && systemIsDark === true);
    themeColour?.setAttribute('content', darkMode ? '#17211c' : '#28684e');
    const androidWindow = this.document.defaultView as
      (Window & { CardNestSystemBars?: AndroidSystemBars }) | null;
    androidWindow?.CardNestSystemBars?.setDarkMode(darkMode);
  }

  private isTheme(value: string | undefined): value is AppTheme {
    return value === 'SYSTEM' || value === 'LIGHT' || value === 'DARK';
  }
}
