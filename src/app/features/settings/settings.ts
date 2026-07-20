import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
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
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
import { AppDateFormat, DateFormatService } from '../../core/services/date-format.service';
import { APP_VERSION } from '../../core/app-version';
import { Capacitor } from '@capacitor/core';
import { PaymentSourcePicker } from '../../shared/payment-source-picker';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';
import { UiPreferencesService } from '../../core/services/ui-preferences.service';

type PinAction = 'CHANGE' | 'DISABLE';
type BackupAction = 'CREATE' | 'RESTORE';
type ProtectedDataAction = 'DELETE_ALL' | 'RETENTION';

@Component({
  selector: 'app-settings-page',
  imports: [ReactiveFormsModule, AppIcon, ConfirmationDialog, PaymentSourcePicker, AppSelectPicker],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  host: { '(document:keydown.escape)': 'closeDialogs()' },
})
export class SettingsPage {
  readonly appVersion = APP_VERSION;
  readonly showAppVersion = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  readonly copyright =
    new Date().getFullYear() > 2026 ? `2026 – ${new Date().getFullYear()}` : '2026';
  readonly database = inject(SqliteDatabase);
  readonly store = inject(CardNestStore);
  readonly notifications = inject(NotificationService);
  readonly pin = inject(ApplicationPinService);
  readonly appLock = inject(AppLockService);
  readonly uiPreferences = inject(UiPreferencesService);
  private readonly themes = inject(ThemeService);
  private readonly snackbar = inject(SnackbarService);
  private readonly backups = inject(BackupService);
  private readonly exporter = inject(ExportService);
  readonly dateFormats = inject(DateFormatService);
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
  readonly revealBackupPassphrase = signal(false);
  readonly revealBackupConfirmation = signal(false);
  readonly restoreConfirmationOpen = signal(false);
  readonly deleteAllConfirmationOpen = signal(false);
  readonly retentionConfirmationOpen = signal(false);
  readonly retentionYears = signal(5);
  readonly autoLockDelay = signal('5');
  readonly defaultCurrency = signal('INR');
  readonly reminderTiming = signal('5');
  readonly autoLockOptions: readonly AppSelectOption[] = [
    { value: '1', label: '1 minute' },
    { value: '5', label: '5 minutes' },
    { value: '15', label: '15 minutes' },
    { value: '30', label: '30 minutes' },
  ];
  readonly titleOptions: readonly AppSelectOption[] = [
    { value: '', label: 'No title' },
    { value: 'Mr', label: 'Mr' },
    { value: 'Ms', label: 'Ms' },
    { value: 'Mrs', label: 'Mrs' },
    { value: 'Mx', label: 'Mx' },
    { value: 'Dr', label: 'Dr' },
  ];
  readonly currencyOptions: readonly AppSelectOption[] = [
    { value: 'INR', label: 'Indian Rupee — INR' },
    { value: 'USD', label: 'US Dollar — USD' },
    { value: 'EUR', label: 'Euro — EUR' },
    { value: 'GBP', label: 'British Pound — GBP' },
  ];
  readonly dateFormatOptions: readonly AppSelectOption[] = this.dateFormats.options.map(
    (option) => ({ value: option.value, label: option.label }),
  );
  readonly reminderTimingOptions: readonly AppSelectOption[] = [
    { value: '5', label: '5 days before' },
    { value: '3', label: '3 days before' },
    { value: '1', label: '1 day before' },
    { value: '0', label: 'On due date' },
  ];
  readonly retentionOptions: readonly AppSelectOption[] = [3, 5, 7, 10].map((years) => ({
    value: String(years),
    label: `${years} years`,
  }));
  readonly protectedAction = signal<ProtectedDataAction | null>(null);
  readonly destructivePin = signal('');
  readonly destructiveAuthError = signal<string | null>(null);
  readonly processingProtectedAction = signal(false);
  readonly retentionCandidateCount = computed(() => {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - this.retentionYears());
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    return this.store
      .transactions()
      .filter((transaction) => transaction.transactionDate < cutoffIso).length;
  });
  private selectedBackupContents = '';
  private pendingRestorePassphrase = '';
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
    if (this.protectedAction()) {
      this.closeProtectedAction();
      return;
    }
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

  toggleFlashTransactionVisibility(): void {
    this.uiPreferences.setShowFlashTransaction(!this.uiPreferences.showFlashTransaction());
  }

  toggleScreenshotPrevention(): void {
    this.uiPreferences.setPreventScreenshots(!this.uiPreferences.preventScreenshots());
    this.snackbar.show(
      this.uiPreferences.preventScreenshots()
        ? 'Screenshot protection enabled.'
        : 'Screenshot protection disabled.',
      'INFO',
    );
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

  async updateProfileTitle(value: string): Promise<void> {
    await this.store.setProfileTitle(value);
  }

  async updateProfileName(event: Event): Promise<void> {
    await this.store.setProfileName((event.target as HTMLInputElement).value);
    this.preferenceMessage.set(
      this.store.profileName() ? 'Greeting name saved.' : 'Greeting name removed.',
    );
  }

  async updateDateFormat(value: string): Promise<void> {
    await this.dateFormats.setFormat(value as AppDateFormat);
    this.preferenceMessage.set('Date format updated.');
  }

  async updateFlashSource(sourceId: string): Promise<void> {
    await this.store.setFlashTransactionSource(sourceId);
    this.preferenceMessage.set('Flash transaction source updated.');
  }

  async toggleReminders(): Promise<void> {
    const enable = !this.reminders();
    if (!enable) {
      await this.notifications.cancelAll(this.store.cards());
      this.snackbar.show('Payment reminders disabled.', 'INFO');
      return;
    }
    const granted = await this.notifications.requestPermission(this.store.cards(), (cardId) =>
      this.store.cardDueAmount(cardId),
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
    if (this.backupAction() === 'RESTORE') {
      this.pendingRestorePassphrase = passphrase;
      this.restoreConfirmationOpen.set(true);
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
    } catch (error: unknown) {
      this.backupError.set(
        error instanceof Error ? error.message : 'The backup operation could not be completed.',
      );
    } finally {
      this.processingBackup.set(false);
    }
  }

  async confirmRestoreBackup(): Promise<void> {
    this.restoreConfirmationOpen.set(false);
    this.processingBackup.set(true);
    this.backupError.set(null);
    try {
      await this.backups.restore(this.selectedBackupContents, this.pendingRestorePassphrase);
      this.showBackupDialog.set(false);
      this.snackbar.show('Backup restored. CardNest will reload now.');
      globalThis.setTimeout(() => globalThis.location.reload(), 900);
    } catch (error: unknown) {
      this.backupError.set(
        error instanceof Error ? error.message : 'The backup operation could not be completed.',
      );
    } finally {
      this.processingBackup.set(false);
      this.pendingRestorePassphrase = '';
    }
  }

  async confirmDeleteAllData(): Promise<void> {
    this.deleteAllConfirmationOpen.set(false);
    await this.requestProtectedAction('DELETE_ALL');
  }

  updateRetentionYears(value: string): void {
    this.retentionYears.set(Number(value));
  }

  async confirmRetentionCleanup(): Promise<void> {
    this.retentionConfirmationOpen.set(false);
    await this.requestProtectedAction('RETENTION');
  }

  async submitDestructivePin(event: Event): Promise<void> {
    event.preventDefault();
    if (!(await this.pin.verifyPin(this.destructivePin()))) {
      this.destructiveAuthError.set('The application PIN is incorrect.');
      return;
    }
    await this.executeProtectedAction();
  }

  async authenticateDestructiveWithBiometrics(): Promise<void> {
    this.destructiveAuthError.set(null);
    if (!(await this.appLock.authenticateWithBiometrics())) {
      this.destructiveAuthError.set(
        this.appLock.biometricError() ?? 'Biometric authentication was not completed.',
      );
      return;
    }
    await this.executeProtectedAction();
  }

  closeProtectedAction(): void {
    if (this.processingProtectedAction()) return;
    this.protectedAction.set(null);
    this.destructivePin.set('');
    this.destructiveAuthError.set(null);
  }

  private async requestProtectedAction(action: ProtectedDataAction): Promise<void> {
    if (!this.pin.hasPin()) {
      this.protectedAction.set(action);
      await this.executeProtectedAction();
      return;
    }
    this.protectedAction.set(action);
    this.destructivePin.set('');
    this.destructiveAuthError.set(null);
  }

  private async executeProtectedAction(): Promise<void> {
    const action = this.protectedAction();
    if (!action || this.processingProtectedAction()) return;
    this.processingProtectedAction.set(true);
    try {
      if (action === 'DELETE_ALL') {
        await this.notifications.cancelAll(this.store.cards());
        await this.store.deleteAllData();
        this.snackbar.show('All CardNest data deleted.', 'WARNING');
        globalThis.setTimeout(() => globalThis.location.reload(), 700);
        return;
      }
      const removed = await this.store.retainRecentYears(this.retentionYears());
      this.snackbar.show(
        removed
          ? `${removed} older ${removed === 1 ? 'transaction was' : 'transactions were'} deleted.`
          : `No transactions older than ${this.retentionYears()} years were found.`,
        removed ? 'WARNING' : 'INFO',
      );
    } catch (error: unknown) {
      this.destructiveAuthError.set(
        error instanceof Error ? error.message : 'The data cleanup could not be completed.',
      );
      return;
    } finally {
      this.processingProtectedAction.set(false);
    }
    this.closeProtectedAction();
  }

  private resetBackupDialog(action: BackupAction): void {
    this.backupAction.set(action);
    this.backupPin.set('');
    this.backupPassphrase.set('');
    this.backupConfirmation.set('');
    this.backupError.set(null);
    this.revealBackupPassphrase.set(false);
    this.revealBackupConfirmation.set(false);
    this.restoreConfirmationOpen.set(false);
  }
}
