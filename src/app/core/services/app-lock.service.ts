import { DOCUMENT } from '@angular/common';
import { Service, inject, signal } from '@angular/core';
import { SqliteDatabase } from '../data/sqlite-database';
import { ApplicationPinService } from './application-pin.service';

const LOCK_ON_BACKGROUND_KEY = 'security_lock_on_background';
const BIOMETRIC_KEY = 'security_biometric_unlock';

interface CardNestNativeBridge {
  isBiometricAvailable(): boolean;
  authenticateBiometric(): void;
  cancelBiometric?(): void;
}

interface CardNestNativeWindow extends Window {
  CardNestNative?: CardNestNativeBridge;
}

/**
 * Locks the application behind the PIN when it returns from the background so card
 * data is never exposed in recent-app previews or on a shared device.
 */
@Service()
export class AppLockService {
  private readonly document = inject(DOCUMENT);
  private readonly database = inject(SqliteDatabase);
  private readonly pin = inject(ApplicationPinService);

  readonly locked = signal(false);
  readonly lockOnBackground = signal(true);
  readonly biometricEnabled = signal(false);
  readonly biometricAvailable = signal(false);
  readonly biometricInProgress = signal(false);
  readonly biometricAutoAttemptAvailable = signal(true);
  readonly biometricError = signal<string | null>(null);
  readonly foreground = signal(this.document.visibilityState !== 'hidden');
  private listening = false;
  private cancelBiometricAttempt: (() => void) | null = null;

  async initialise(): Promise<void> {
    this.refreshBiometricAvailability();
    for (const delay of [150, 600, 1500]) {
      globalThis.setTimeout(() => this.refreshBiometricAvailability(), delay);
    }
    if (this.database.ready()) {
      this.lockOnBackground.set((await this.readPreference(LOCK_ON_BACKGROUND_KEY)) ?? true);
      this.biometricEnabled.set((await this.readPreference(BIOMETRIC_KEY)) ?? false);
    }
    // Require the PIN on a cold start when protection is enabled.
    if (this.canLock()) this.locked.set(true);
    this.startListening();
  }

  async unlock(pin: string): Promise<boolean> {
    const verified = await this.pin.verifyPin(pin);
    if (verified) this.locked.set(false);
    return verified;
  }

  async setLockOnBackground(enabled: boolean): Promise<void> {
    this.lockOnBackground.set(enabled);
    await this.writePreference(LOCK_ON_BACKGROUND_KEY, enabled);
  }

  async setBiometricEnabled(enabled: boolean): Promise<boolean> {
    if (enabled) {
      if (!this.pin.hasPin()) {
        this.biometricError.set('Set an application PIN before enabling biometric unlock.');
        return false;
      }
      if (!(await this.authenticateWithBiometrics())) return false;
    }
    this.biometricEnabled.set(enabled);
    await this.writePreference(BIOMETRIC_KEY, enabled);
    return enabled;
  }

  async authenticateWithBiometrics(): Promise<boolean> {
    this.refreshBiometricAvailability();
    if (!this.foreground() || !this.biometricAvailable() || this.biometricInProgress())
      return false;
    const nativeBridge = (this.document.defaultView as CardNestNativeWindow | null)?.CardNestNative;
    if (!nativeBridge) return false;
    this.biometricInProgress.set(true);
    this.biometricAutoAttemptAvailable.set(false);
    this.biometricError.set(null);
    try {
      const success = await new Promise<boolean>((resolve) => {
        let completed = false;
        const finish = (result: boolean) => {
          if (completed) return;
          completed = true;
          globalThis.clearTimeout(timeout);
          this.document.defaultView?.removeEventListener('cardnest-native-result', handleResult);
          this.cancelBiometricAttempt = null;
          resolve(result);
        };
        const handleResult = (event: Event) => {
          const detail = (
            event as CustomEvent<{ action: string; success: boolean; message?: string }>
          ).detail;
          if (detail.action !== 'biometric') return;
          if (!detail.success) this.biometricError.set(detail.message ?? 'Biometric check failed.');
          finish(detail.success);
        };
        const timeout = globalThis.setTimeout(() => {
          this.biometricError.set('Biometric check timed out. Please try again.');
          finish(false);
        }, 30_000);
        this.cancelBiometricAttempt = () => finish(false);
        this.document.defaultView?.addEventListener('cardnest-native-result', handleResult);
        nativeBridge.authenticateBiometric();
      });
      if (success) this.locked.set(false);
      return success;
    } finally {
      this.biometricInProgress.set(false);
    }
  }

  private canLock(): boolean {
    return this.pin.hasPin() && this.lockOnBackground();
  }

  private hasNativeBiometrics(): boolean {
    try {
      return (
        (
          this.document.defaultView as CardNestNativeWindow | null
        )?.CardNestNative?.isBiometricAvailable() === true
      );
    } catch {
      return false;
    }
  }

  private refreshBiometricAvailability(): void {
    this.biometricAvailable.set(this.hasNativeBiometrics());
  }

  private startListening(): void {
    if (this.listening) return;
    this.listening = true;
    this.document.addEventListener('visibilitychange', () => {
      const foreground = this.document.visibilityState !== 'hidden';
      this.foreground.set(foreground);
      if (!foreground) {
        this.biometricAutoAttemptAvailable.set(true);
        this.cancelActiveBiometricAttempt();
        if (this.canLock()) this.locked.set(true);
        return;
      }
      this.refreshBiometricAvailability();
    });
  }

  private cancelActiveBiometricAttempt(): void {
    const nativeBridge = (this.document.defaultView as CardNestNativeWindow | null)?.CardNestNative;
    nativeBridge?.cancelBiometric?.();
    this.cancelBiometricAttempt?.();
    this.cancelBiometricAttempt = null;
    this.biometricInProgress.set(false);
    this.biometricError.set(null);
  }

  private async readPreference(key: string): Promise<boolean | null> {
    const rows = await this.database.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key = ?',
      [key],
    );
    const value = rows[0]?.encrypted_value;
    return value === undefined ? null : value === '1';
  }

  private async writePreference(key: string, enabled: boolean): Promise<void> {
    if (!this.database.ready()) return;
    await this.database.run(
      `INSERT INTO app_preferences (key, encrypted_value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value`,
      [key, enabled ? '1' : '0'],
    );
  }
}
