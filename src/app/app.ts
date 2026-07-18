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
import { CardTransaction } from './core/models/domain';
import { parseMoneyToMinor } from './core/services/money';

interface NativeLaunchBridge {
  hideSplash(): void;
}

interface NativeLaunchWindow extends Window {
  CardNestNative?: NativeLaunchBridge;
}

function sanitizedMoneyInput(value: string): string {
  const numeric = value.replace(/[^0-9.]/g, '');
  const [whole = '', ...fractions] = numeric.split('.');
  return fractions.length ? `${whole}.${fractions.join('').slice(0, 2)}` : whole;
}

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
  readonly store = inject(CardNestStore);
  private readonly notifications = inject(NotificationService);
  readonly database = inject(SqliteDatabase);
  readonly appLock = inject(AppLockService);
  readonly snackbar = inject(SnackbarService);

  readonly showNotificationPermissionConfirmation = signal(false);
  readonly mobileMenuOpen = signal(false);
  readonly lockPin = signal('');
  readonly lockError = signal<string | null>(null);
  readonly unlocking = signal(false);
  readonly flashTransactionOpen = signal(false);
  readonly flashSourceId = signal('');
  readonly flashAmount = signal('');
  readonly flashMerchant = signal('');
  readonly flashError = signal<string | null>(null);
  readonly allowNotificationsButton = viewChild<ElementRef<HTMLButtonElement>>(
    'allowNotificationsButton',
  );
  readonly mainContent = viewChild<ElementRef<HTMLElement>>('mainContent');

  constructor() {
    effect(() => {
      const cards = this.store.cards();
      this.store.transactions();
      void this.notifications.reschedule(cards, (cardId) => this.store.cardDueAmount(cardId));
    });

    effect(() => {
      if (
        this.appLock.locked() &&
        this.appLock.foreground() &&
        this.appLock.biometricEnabled() &&
        this.appLock.biometricAvailable() &&
        this.appLock.biometricAutoAttemptAvailable() &&
        !this.appLock.biometricInProgress()
      ) {
        queueMicrotask(() => void this.appLock.authenticateWithBiometrics());
      }
    });

    afterNextRender(() => {
      (globalThis.window as NativeLaunchWindow | undefined)?.CardNestNative?.hideSplash();
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
      this.store.cardDueAmount(cardId),
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

  openFlashTransaction(): void {
    const availableIds = [
      ...this.store.activeCards().map((card) => card.id),
      ...this.store.activePaymentSources().map((source) => source.id),
    ];
    const preferred = this.store.flashTransactionSourceId();
    this.flashSourceId.set(availableIds.includes(preferred) ? preferred : (availableIds[0] ?? ''));
    this.flashAmount.set('');
    this.flashMerchant.set('');
    this.flashError.set(null);
    this.flashTransactionOpen.set(true);
  }

  closeFlashTransaction(): void {
    this.flashTransactionOpen.set(false);
    this.flashError.set(null);
  }

  closeFlashFromBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closeFlashTransaction();
  }

  sanitizeFlashAmount(event: Event): void {
    const input = event.target as HTMLInputElement;
    const sanitized = sanitizedMoneyInput(input.value);
    input.value = sanitized;
    this.flashAmount.set(sanitized);
  }

  async updateFlashSource(event: Event): Promise<void> {
    const sourceId = (event.target as HTMLSelectElement).value;
    this.flashSourceId.set(sourceId);
    try {
      await this.store.setFlashTransactionSource(sourceId);
    } catch {
      this.snackbar.show('Preferred Flash source could not be saved.', 'WARNING');
    }
  }

  saveFlashTransaction(event: Event): void {
    event.preventDefault();
    const amountMinor = parseMoneyToMinor(this.flashAmount());
    if (!this.flashSourceId() || amountMinor === null || amountMinor <= 0) {
      this.flashError.set('Enter an amount and choose a payment source.');
      return;
    }
    const timestamp = new Date().toISOString();
    const transaction: CardTransaction = {
      id: crypto.randomUUID(),
      cardId: this.flashSourceId(),
      type: 'PURCHASE',
      amountMinor,
      currencyCode: 'INR',
      transactionDate: timestamp.slice(0, 10),
      merchant: this.flashMerchant().trim() || undefined,
      categoryId: 'other',
      attachmentIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.addTransaction(transaction);
    if (this.store.flashTransactionSourceId() !== this.flashSourceId()) {
      void this.store
        .setFlashTransactionSource(this.flashSourceId())
        .catch(() =>
          this.snackbar.show(
            'Transaction saved, but the preferred Flash source was not.',
            'WARNING',
          ),
        );
    }
    this.closeFlashTransaction();
    this.snackbar.show('Flash transaction added.');
  }

  private async openNotificationPermissionConfirmationIfNeeded(): Promise<void> {
    if (!(await this.notifications.shouldRequestNotificationPermission())) return;
    this.showNotificationPermissionConfirmation.set(true);
    queueMicrotask(() => this.allowNotificationsButton()?.nativeElement.focus());
  }
}
