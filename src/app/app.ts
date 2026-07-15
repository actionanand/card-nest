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
import { AppLockService } from './core/services/app-lock.service';
import { CardNestStore } from './core/services/card-nest-store';
import { NotificationService } from './core/services/notification.service';
import { SnackbarService } from './core/services/snackbar.service';
import { AppIcon } from './shared/app-icon';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, AppIcon],
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
  readonly appLock = inject(AppLockService);
  readonly snackbar = inject(SnackbarService);

  readonly showNotificationPermissionConfirmation = signal(false);
  readonly mobileMenuOpen = signal(false);
  readonly lockPin = signal('');
  readonly lockError = signal<string | null>(null);
  readonly unlocking = signal(false);
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

    effect(() => {
      if (
        this.appLock.locked() &&
        this.appLock.biometricEnabled() &&
        this.appLock.biometricAvailable()
      ) {
        queueMicrotask(() => void this.appLock.authenticateWithBiometrics());
      }
    });

    afterNextRender(() => {
      this.store.materializeRecurringTransactions();
      void this.openNotificationPermissionConfirmationIfNeeded();
    });
  }

  dismissNotificationPermissionConfirmation(): void {
    this.mobileMenuOpen.set(false);
    if (!this.showNotificationPermissionConfirmation()) return;
    this.showNotificationPermissionConfirmation.set(false);
    queueMicrotask(() => this.mainContent()?.nativeElement.focus());
  }

  async confirmNotificationPermission(): Promise<void> {
    this.showNotificationPermissionConfirmation.set(false);
    const granted = await this.notifications.requestPermission(this.store.cards(), (cardId) =>
      this.store.cardOutstanding(cardId),
    );

    this.snackbar.show(
      granted
        ? 'Notifications are enabled. CardNest will send private card reminders.'
        : 'Notifications were not enabled. You can allow them later in Android settings.',
      granted ? 'SUCCESS' : 'WARNING',
      15000,
    );
    queueMicrotask(() => this.mainContent()?.nativeElement.focus());
  }

  async submitUnlock(event: Event): Promise<void> {
    event.preventDefault();
    if (this.unlocking()) return;
    this.unlocking.set(true);
    this.lockError.set(null);
    try {
      const unlocked = await this.appLock.unlock(this.lockPin());
      if (unlocked) {
        this.lockPin.set('');
        return;
      }
      this.lockError.set('Incorrect PIN. Please try again.');
    } finally {
      this.unlocking.set(false);
    }
  }

  private async openNotificationPermissionConfirmationIfNeeded(): Promise<void> {
    if (!(await this.notifications.shouldRequestNotificationPermission())) return;
    this.showNotificationPermissionConfirmation.set(true);
    queueMicrotask(() => this.allowNotificationsButton()?.nativeElement.focus());
  }
}
