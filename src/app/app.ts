import {
  afterNextRender,
  Component,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SqliteDatabase } from './core/data/sqlite-database';
import { CardNestStore } from './core/services/card-nest-store';
import { NotificationService } from './core/services/notification.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: {
    '(document:keydown.escape)': 'dismissNotificationPermissionConfirmation()',
  },
})
export class App {
  private readonly store = inject(CardNestStore);
  private readonly notifications = inject(NotificationService);
  readonly database = inject(SqliteDatabase);

  readonly showNotificationPermissionConfirmation = signal(false);
  readonly notificationPermissionMessage = signal<string | null>(null);
  readonly allowNotificationsButton = viewChild<ElementRef<HTMLButtonElement>>(
    'allowNotificationsButton',
  );
  readonly mainContent = viewChild<ElementRef<HTMLElement>>('mainContent');

  constructor() {
    effect(() => {
      const cards = this.store.cards();
      this.store.transactions();
      void this.notifications.reschedule(cards, (cardId) => this.store.cardOutstanding(cardId));
    });

    afterNextRender(() => {
      void this.openNotificationPermissionConfirmationIfNeeded();
    });
  }

  dismissNotificationPermissionConfirmation(): void {
    if (!this.showNotificationPermissionConfirmation()) return;
    this.showNotificationPermissionConfirmation.set(false);
    queueMicrotask(() => this.mainContent()?.nativeElement.focus());
  }

  async confirmNotificationPermission(): Promise<void> {
    this.showNotificationPermissionConfirmation.set(false);
    const granted = await this.notifications.requestPermission(this.store.cards(), (cardId) =>
      this.store.cardOutstanding(cardId),
    );

    this.notificationPermissionMessage.set(
      granted
        ? 'Notifications are enabled. CardNest will send private card reminders.'
        : 'Notifications were not enabled. You can allow them later in Android settings.',
    );
    queueMicrotask(() => this.mainContent()?.nativeElement.focus());
  }

  private async openNotificationPermissionConfirmationIfNeeded(): Promise<void> {
    if (!(await this.notifications.shouldRequestNotificationPermission())) return;
    this.showNotificationPermissionConfirmation.set(true);
    queueMicrotask(() => this.allowNotificationsButton()?.nativeElement.focus());
  }
}
