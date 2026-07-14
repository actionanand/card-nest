import { Component, inject, signal } from '@angular/core';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { CardNestStore } from '../../core/services/card-nest-store';
import { NotificationService } from '../../core/services/notification.service';
import { AppTheme, ThemeService } from '../../core/services/theme.service';

@Component({
  selector: 'app-settings-page',
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class SettingsPage {
  readonly database = inject(SqliteDatabase);
  readonly store = inject(CardNestStore);
  readonly notifications = inject(NotificationService);
  private readonly themes = inject(ThemeService);
  readonly theme = this.themes.theme;
  readonly themeOptions: readonly AppTheme[] = ['SYSTEM', 'LIGHT', 'DARK'];
  readonly biometric = signal(false);
  readonly lockOnBackground = signal(true);
  readonly reminders = this.notifications.enabled;

  setTheme(theme: AppTheme): void {
    void this.themes.setTheme(theme);
  }

  async toggleReminders(): Promise<void> {
    const enable = !this.reminders();
    if (!enable) {
      await this.notifications.cancelAll(this.store.cards());
      return;
    }
    const granted = await this.notifications.requestPermission(this.store.cards(), (cardId) =>
      this.store.cardOutstanding(cardId),
    );
    if (!granted) this.reminders.set(false);
  }
}
