import { Component, inject, signal } from '@angular/core';
import { SqliteDatabase } from '../../core/data/sqlite-database';

@Component({
  selector: 'app-settings-page',
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class SettingsPage {
  readonly database = inject(SqliteDatabase);
  readonly theme = signal<'SYSTEM' | 'LIGHT' | 'DARK'>('SYSTEM');
  readonly biometric = signal(false);
  readonly lockOnBackground = signal(true);
  readonly reminders = signal(true);
}
