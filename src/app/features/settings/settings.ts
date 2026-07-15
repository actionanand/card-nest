import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Capacitor } from '@capacitor/core';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { ApplicationPinService } from '../../core/services/application-pin.service';
import { AppLockService } from '../../core/services/app-lock.service';
import { CardNestStore } from '../../core/services/card-nest-store';
import { NotificationService } from '../../core/services/notification.service';
import { AppTheme, ThemeService } from '../../core/services/theme.service';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { AppIcon } from '../../shared/app-icon';

@Component({
  selector: 'app-settings-page',
  imports: [ReactiveFormsModule, AppIcon],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  host: { '(document:keydown.escape)': 'closePinForm()' },
})
export class SettingsPage {
  readonly database = inject(SqliteDatabase);
  readonly store = inject(CardNestStore);
  readonly notifications = inject(NotificationService);
  readonly pin = inject(ApplicationPinService);
  readonly appLock = inject(AppLockService);
  private readonly themes = inject(ThemeService);
  readonly theme = this.themes.theme;
  readonly themeOptions: readonly AppTheme[] = ['SYSTEM', 'LIGHT', 'DARK'];
  readonly biometric = this.appLock.biometricEnabled;
  readonly biometricAvailable = Capacitor.getPlatform() === 'android';
  readonly lockOnBackground = this.appLock.lockOnBackground;
  readonly reminders = this.notifications.enabled;
  readonly showPinForm = signal(false);
  readonly pinError = signal<string | null>(null);
  readonly pinMessage = signal<string | null>(null);
  readonly preferenceMessage = signal<string | null>(null);
  readonly savingPin = signal(false);
  readonly pinButton = viewChild<ElementRef<HTMLButtonElement>>('pinButton');
  readonly currentPinInput = viewChild<ElementRef<HTMLInputElement>>('currentPinInput');
  readonly newPinInput = viewChild<ElementRef<HTMLInputElement>>('newPinInput');
  readonly pinForm = new FormGroup({
    currentPin: new FormControl('', { nonNullable: true }),
    newPin: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^\d{4,8}$/)],
    }),
    confirmPin: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^\d{4,8}$/)],
    }),
  });

  setTheme(theme: AppTheme): void {
    void this.themes.setTheme(theme);
  }

  openPinForm(): void {
    this.pinError.set(null);
    this.pinMessage.set(null);
    this.pinForm.reset({ currentPin: '', newPin: '', confirmPin: '' });
    this.showPinForm.set(true);
    queueMicrotask(() => {
      (this.currentPinInput() ?? this.newPinInput())?.nativeElement.focus();
    });
  }

  closePinForm(): void {
    if (!this.showPinForm()) return;
    this.showPinForm.set(false);
    this.pinError.set(null);
    queueMicrotask(() => this.pinButton()?.nativeElement.focus());
  }

  async savePin(): Promise<void> {
    this.pinForm.markAllAsTouched();
    const value = this.pinForm.getRawValue();
    if (this.pinForm.invalid) {
      this.pinError.set('Use a PIN containing 4 to 8 digits.');
      return;
    }
    if (value.newPin !== value.confirmPin) {
      this.pinError.set('The new PIN and confirmation do not match.');
      return;
    }
    if (this.pin.hasPin() && !value.currentPin) {
      this.pinError.set('Enter the current PIN.');
      return;
    }
    this.savingPin.set(true);
    this.pinError.set(null);
    try {
      const changed = await this.pin.changePin(value.currentPin, value.newPin);
      if (!changed) {
        this.pinError.set('The current PIN is incorrect.');
        return;
      }
      this.pinMessage.set('Application PIN updated successfully.');
      this.closePinForm();
      this.pinForm.reset({ currentPin: '', newPin: '', confirmPin: '' });
    } catch (error: unknown) {
      this.pinError.set(error instanceof Error ? error.message : 'The PIN could not be updated.');
    } finally {
      this.savingPin.set(false);
    }
  }

  toggleBiometric(): void {
    if (!this.biometricAvailable) return;
    void this.appLock.setBiometricEnabled(!this.biometric());
  }

  toggleLockOnBackground(): void {
    void this.appLock.setLockOnBackground(!this.lockOnBackground());
  }

  money(value: number): string {
    return formatMoney(value, 'INR');
  }

  async updateMoney(event: Event, target: 'income' | 'budget'): Promise<void> {
    const value = parseMoneyToMinor((event.target as HTMLInputElement).value);
    if (value === null) return;
    try {
      if (target === 'income') await this.store.setMonthlyIncome(value);
      else await this.store.setMonthlyBudget(value);
      this.preferenceMessage.set(
        target === 'income'
          ? `Income saved for ${this.store.currentIncomePeriodLabel()}.`
          : 'Monthly budget saved.',
      );
    } catch (error: unknown) {
      this.preferenceMessage.set(
        error instanceof Error ? error.message : 'The preference could not be saved.',
      );
    }
  }

  async updateCycleDay(event: Event): Promise<void> {
    const value = Number((event.target as HTMLInputElement).value);
    await this.store.setBudgetCycleStartDay(value);
    this.preferenceMessage.set(
      `Budget cycle updated. Current income period: ${this.store.currentIncomePeriodLabel()}.`,
    );
  }

  async updateProfileTitle(event: Event): Promise<void> {
    await this.store.setProfileTitle((event.target as HTMLSelectElement).value);
  }

  async updateProfileName(event: Event): Promise<void> {
    await this.store.setProfileName((event.target as HTMLInputElement).value);
    this.preferenceMessage.set(
      this.store.profileName() ? 'Greeting name saved.' : 'Greeting name removed.',
    );
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
