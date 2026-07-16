import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { ApplicationPinService } from '../../core/services/application-pin.service';
import { AppLockService } from '../../core/services/app-lock.service';
import { CardNestStore } from '../../core/services/card-nest-store';
import { NotificationService } from '../../core/services/notification.service';
import { AppTheme, ThemeService } from '../../core/services/theme.service';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { AppIcon } from '../../shared/app-icon';
import { SnackbarService } from '../../core/services/snackbar.service';
import { BackupService } from '../../core/services/backup.service';
import { ExportService } from '../../core/services/export.service';

type PinAction = 'CHANGE' | 'DISABLE';
type BackupAction = 'CREATE' | 'RESTORE';

@Component({
  selector: 'app-settings-page',
  imports: [ReactiveFormsModule, AppIcon],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  host: { '(document:keydown.escape)': 'closeDialogs()' },
})
export class SettingsPage {
  readonly database = inject(SqliteDatabase);
  readonly store = inject(CardNestStore);
  readonly notifications = inject(NotificationService);
  readonly pin = inject(ApplicationPinService);
  readonly appLock = inject(AppLockService);
  private readonly themes = inject(ThemeService);
  private readonly snackbar = inject(SnackbarService);
  private readonly backups = inject(BackupService);
  private readonly exporter = inject(ExportService);
  readonly theme = this.themes.theme;
  readonly themeOptions: readonly AppTheme[] = ['SYSTEM', 'LIGHT', 'DARK'];
  readonly biometric = this.appLock.biometricEnabled;
  readonly biometricAvailable = this.appLock.biometricAvailable;
  readonly lockOnBackground = this.appLock.lockOnBackground;
  readonly reminders = this.notifications.enabled;
  readonly showPinForm = signal(false);
  readonly pinAction = signal<PinAction>('CHANGE');
  readonly pinError = signal<string | null>(null);
  readonly pinMessage = signal<string | null>(null);
  readonly preferenceMessage = signal<string | null>(null);
  readonly savingPin = signal(false);
  readonly showBackupDialog = signal(false);
  readonly backupAction = signal<BackupAction>('CREATE');
  readonly backupPin = signal('');
  readonly backupPassphrase = signal('');
  readonly backupConfirmation = signal('');
  readonly backupError = signal<string | null>(null);
  readonly processingBackup = signal(false);
  private selectedBackupContents = '';
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

  openPinForm(action: PinAction = 'CHANGE'): void {
    this.pinAction.set(action);
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

  closeDialogs(): void {
    if (this.showBackupDialog()) {
      this.closeBackupDialog();
      return;
    }
    this.closePinForm();
  }

  async savePin(): Promise<void> {
    const value = this.pinForm.getRawValue();
    if (this.pinAction() === 'DISABLE') {
      if (!value.currentPin) {
        this.pinError.set('Enter the current PIN.');
        return;
      }
      this.savingPin.set(true);
      this.pinError.set(null);
      try {
        const disabled = await this.pin.disablePin(value.currentPin);
        if (!disabled) {
          this.pinError.set('The current PIN is incorrect.');
          return;
        }
        await this.appLock.setBiometricEnabled(false);
        this.pinMessage.set('Application PIN disabled.');
        this.snackbar.show('Application PIN disabled.', 'INFO');
        this.closePinForm();
      } finally {
        this.savingPin.set(false);
      }
      return;
    }
    this.pinForm.markAllAsTouched();
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

  async toggleBiometric(): Promise<void> {
    if (!this.biometricAvailable()) return;
    const requested = !this.biometric();
    const enabled = await this.appLock.setBiometricEnabled(requested);
    if (requested && !enabled) {
      this.snackbar.show(
        this.appLock.biometricError() ?? 'Biometric unlock could not be enabled.',
        'WARNING',
      );
      return;
    }
    this.snackbar.show(
      enabled ? 'Biometric unlock enabled.' : 'Biometric unlock disabled.',
      enabled ? 'SUCCESS' : 'INFO',
    );
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

  async updateEmiMinimum(event: Event): Promise<void> {
    const amount = parseMoneyToMinor((event.target as HTMLInputElement).value);
    if (amount === null || amount <= 0) {
      this.preferenceMessage.set('Enter a valid minimum amount for EMI conversion.');
      return;
    }
    await this.store.setEmiMinimum(amount);
    this.preferenceMessage.set('Minimum amount for EMI conversion updated.');
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
      this.snackbar.show('Payment reminders disabled.', 'INFO');
      return;
    }
    const granted = await this.notifications.requestPermission(this.store.cards(), (cardId) =>
      this.store.cardOutstanding(cardId),
    );
    if (!granted) {
      this.reminders.set(false);
      this.snackbar.show(
        this.notifications.lastError() ?? 'Notification permission was not granted.',
        'WARNING',
      );
      return;
    }
    this.snackbar.show('Payment reminders enabled and scheduled.');
  }

  openCreateBackup(): void {
    this.resetBackupDialog('CREATE');
    this.showBackupDialog.set(true);
  }

  exportMaskedCsv(): void {
    this.exporter.exportTransactions('CSV', 'ALL', this.store.transactions());
  }

  async openRestoreBackup(): Promise<void> {
    try {
      this.selectedBackupContents = await this.backups.chooseBackup();
      this.resetBackupDialog('RESTORE');
      this.showBackupDialog.set(true);
    } catch (error: unknown) {
      this.snackbar.show(
        error instanceof Error ? error.message : 'The backup file could not be opened.',
        'WARNING',
      );
    }
  }

  closeBackupDialog(): void {
    if (this.processingBackup()) return;
    this.showBackupDialog.set(false);
    this.backupError.set(null);
  }

  async submitBackup(event: Event): Promise<void> {
    event.preventDefault();
    if (this.processingBackup()) return;
    const passphrase = this.backupPassphrase();
    if (this.pin.hasPin() && !(await this.pin.verifyPin(this.backupPin()))) {
      this.backupError.set('The application PIN is incorrect.');
      return;
    }
    if (this.backupAction() === 'CREATE' && passphrase !== this.backupConfirmation()) {
      this.backupError.set('The backup passphrases do not match.');
      return;
    }
    this.processingBackup.set(true);
    this.backupError.set(null);
    try {
      if (this.backupAction() === 'CREATE') {
        const backup = await this.backups.create(passphrase);
        await this.backups.save(backup.fileName, backup.contents);
        this.showBackupDialog.set(false);
        this.snackbar.show('Encrypted backup saved.');
        return;
      }
      if (!globalThis.confirm?.('Restore this backup and replace all current CardNest data?')) {
        return;
      }
      await this.backups.restore(this.selectedBackupContents, passphrase);
      this.showBackupDialog.set(false);
      this.snackbar.show('Backup restored. CardNest will reload now.');
      globalThis.setTimeout(() => globalThis.location.reload(), 900);
    } catch (error: unknown) {
      this.backupError.set(
        error instanceof Error ? error.message : 'The backup operation could not be completed.',
      );
    } finally {
      this.processingBackup.set(false);
    }
  }

  private resetBackupDialog(action: BackupAction): void {
    this.backupAction.set(action);
    this.backupPin.set('');
    this.backupPassphrase.set('');
    this.backupConfirmation.set('');
    this.backupError.set(null);
  }
}
