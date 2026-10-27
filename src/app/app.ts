import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SqliteDatabase } from './core/data/sqlite-database';
import { AppLockService } from './core/services/app-lock.service';
import { CardNestStore } from './core/services/card-nest-store';
import { NotificationService } from './core/services/notification.service';
import { SnackbarService } from './core/services/snackbar.service';
import { AppIcon } from './shared/app-icon';
import { PaymentSourcePicker } from './shared/payment-source-picker';
import { CardTransaction } from './core/models/domain';
import { indiaTodayIso } from './core/services/india-date';
import { parseMoneyToMinor } from './core/services/money';
import { UiPreferencesService } from './core/services/ui-preferences.service';
import { UtilitiesService } from './features/utilities/utilities.service';

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
  imports: [RouterOutlet, RouterLink, RouterLinkActive, AppIcon, PaymentSourcePicker],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: {
    '(document:keydown.escape)': 'dismissNotificationPermissionConfirmation()',
    '(document:focusin)': 'refreshFabKeyboardState()',
    '(document:focusout)': 'refreshFabKeyboardState()',
    '(window:focus)': 'refreshNotificationPermission()',
  },
})
export class App {
  readonly store = inject(CardNestStore);
  private readonly notifications = inject(NotificationService);
  readonly database = inject(SqliteDatabase);
  readonly appLock = inject(AppLockService);
  readonly snackbar = inject(SnackbarService);
  readonly uiPreferences = inject(UiPreferencesService);
  readonly utilities = inject(UtilitiesService);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  readonly showNotificationPermissionConfirmation = signal(false);
  readonly blockingDialogOpen = signal(false);
  readonly mobileMenuOpen = signal(false);
  readonly lockPin = signal('');
  readonly lockError = signal<string | null>(null);
  readonly unlocking = signal(false);
  readonly flashTransactionOpen = signal(false);
  readonly savingFlashTransaction = signal(false);
  readonly smsShortcutNavigationPending = signal(false);
  readonly keyboardInputFocused = signal(false);
  readonly flashSourceId = signal('');
  readonly flashAmount = signal('');
  readonly flashMerchant = signal('');
  readonly flashError = signal<string | null>(null);
  private flashTransactionId: string | null = null;
  readonly allowNotificationsButton = viewChild<ElementRef<HTMLButtonElement>>(
    'allowNotificationsButton',
  );
  readonly mainContent = viewChild<ElementRef<HTMLElement>>('mainContent');
  readonly floatingShortcutVisible = computed(
    () =>
      this.uiPreferences.androidNative &&
      this.database.ready() &&
      this.uiPreferences.floatingShortcutEnabled() &&
      this.appLock.foreground() &&
      !this.appLock.locked() &&
      !this.blockingDialogOpen() &&
      !this.showNotificationPermissionConfirmation() &&
      !this.snackbar.message() &&
      !this.keyboardInputFocused() &&
      !this.flashTransactionOpen(),
  );

  constructor() {
    this.refreshFabKeyboardState();
    const MutationObserverClass = this.document.defaultView?.MutationObserver;
    if (
      this.uiPreferences.androidNative &&
      MutationObserverClass &&
      this.document.documentElement
    ) {
      const refreshDialogState = () =>
        this.blockingDialogOpen.set(
          !!this.document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]'),
        );
      const observer = new MutationObserverClass(refreshDialogState);
      observer.observe(this.document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['open', 'aria-modal', 'role'],
      });
      refreshDialogState();
      this.destroyRef.onDestroy(() => observer.disconnect());
    }

    effect(() => {
      const cards = this.store.cards();
      this.store.transactions();
      this.notifications.setUtilityReminders(this.utilities.reminderTargets());
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

  refreshFabKeyboardState(): void {
    queueMicrotask(() => {
      const active = this.document.activeElement as HTMLElement | null;
      const editable =
        !!active &&
        (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName));
      this.keyboardInputFocused.set(this.uiPreferences.androidNative && editable);
    });
  }

  refreshNotificationPermission(): void {
    void this.notifications.refreshPermission();
  }

  async confirmNotificationPermission(): Promise<void> {
    this.showNotificationPermissionConfirmation.set(false);
    const granted = await this.notifications.requestPermission(this.store.cards(), (cardId) =>
      this.store.cardDueAmount(cardId),
    );
    const schedulingError = this.notifications.lastError();

    this.snackbar.show(
      granted && !schedulingError
        ? 'Notifications are enabled. CardNest will send private card reminders.'
        : (schedulingError ??
            'Notifications were not enabled. You can allow them later in Android settings.'),
      granted && !schedulingError ? 'SUCCESS' : 'WARNING',
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
    if (
      !this.floatingShortcutVisible() ||
      this.uiPreferences.floatingShortcutMode() !== 'QUICK_TRANSACTION'
    )
      return;
    const availableIds = [
      ...this.store.alphabeticalActiveCards().map((card) => card.id),
      ...this.store.activePaymentSources().map((source) => source.id),
    ];
    const preferred = this.store.flashTransactionSourceId();
    this.flashSourceId.set(availableIds.includes(preferred) ? preferred : (availableIds[0] ?? ''));
    this.flashAmount.set('');
    this.flashMerchant.set('');
    this.flashError.set(null);
    this.flashTransactionId = null;
    this.flashTransactionOpen.set(true);
  }

  closeFlashTransaction(): void {
    if (this.savingFlashTransaction()) return;
    this.flashTransactionOpen.set(false);
    this.flashError.set(null);
    this.flashTransactionId = null;
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

  updateFlashSource(sourceId: string): void {
    this.flashSourceId.set(sourceId);
  }

  async openSmsSyncFromShortcut(): Promise<void> {
    if (
      !this.floatingShortcutVisible() ||
      this.uiPreferences.floatingShortcutMode() !== 'SMS_SYNC' ||
      this.smsShortcutNavigationPending()
    )
      return;
    const smsSyncRoute = this.router.config.find(
      (route) => route.data?.['floatingShortcut'] === 'SMS_SYNC',
    );
    if (!smsSyncRoute?.path) {
      this.warnSmsShortcutNavigationFailure();
      return;
    }
    const smsSyncUrl = `/${smsSyncRoute.path}`;
    if (this.router.url.split(/[?#]/, 1)[0] === smsSyncUrl) return;
    this.smsShortcutNavigationPending.set(true);
    try {
      if (!(await this.router.navigateByUrl(smsSyncUrl))) this.warnSmsShortcutNavigationFailure();
    } catch {
      this.warnSmsShortcutNavigationFailure();
    } finally {
      this.smsShortcutNavigationPending.set(false);
    }
  }

  async saveFlashTransaction(event: Event): Promise<void> {
    event.preventDefault();
    if (
      !this.flashTransactionOpen() ||
      this.savingFlashTransaction() ||
      !this.uiPreferences.showFlashTransaction()
    )
      return;
    const amountMinor = parseMoneyToMinor(this.flashAmount());
    if (!this.flashSourceId() || amountMinor === null || amountMinor <= 0) {
      this.flashError.set('Enter an amount and choose a payment source.');
      return;
    }
    this.savingFlashTransaction.set(true);
    this.flashError.set(null);
    try {
      const timestamp = new Date().toISOString();
      const transaction: CardTransaction = {
        id: (this.flashTransactionId ??= crypto.randomUUID()),
        cardId: this.flashSourceId(),
        type: 'PURCHASE',
        amountMinor,
        currencyCode: 'INR',
        transactionDate: indiaTodayIso(),
        merchant: this.flashMerchant().trim() || undefined,
        categoryId: 'other',
        attachmentIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.store.saveManualTransaction(transaction);
      this.flashTransactionId = null;
      this.flashTransactionOpen.set(false);
      this.flashError.set(null);
      this.snackbar.show('Flash transaction added.');
    } catch {
      this.flashError.set(
        'Could not save this transaction. Your entries are still here; try again.',
      );
    } finally {
      this.savingFlashTransaction.set(false);
    }
  }

  private warnSmsShortcutNavigationFailure(): void {
    this.snackbar.show('SMS Sync could not be opened. Please try again.', 'WARNING');
  }

  private async openNotificationPermissionConfirmationIfNeeded(): Promise<void> {
    if (!(await this.notifications.shouldRequestNotificationPermission())) return;
    this.showNotificationPermissionConfirmation.set(true);
    queueMicrotask(() => this.allowNotificationsButton()?.nativeElement.focus());
  }
}
