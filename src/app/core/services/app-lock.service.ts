import { DOCUMENT } from '@angular/common';
import { Service, inject, signal } from '@angular/core';
import { SqliteDatabase } from '../data/sqlite-database';
import { ApplicationPinService } from './application-pin.service';

const LOCK_ON_BACKGROUND_KEY = 'security_lock_on_background';
const BIOMETRIC_KEY = 'security_biometric_unlock';

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
  private listening = false;

  async initialise(): Promise<void> {
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

  async setBiometricEnabled(enabled: boolean): Promise<void> {
    this.biometricEnabled.set(enabled);
    await this.writePreference(BIOMETRIC_KEY, enabled);
  }

  private canLock(): boolean {
    return this.pin.hasPin() && this.lockOnBackground();
  }

  private startListening(): void {
    if (this.listening) return;
    this.listening = true;
    this.document.addEventListener('visibilitychange', () => {
      if (this.document.visibilityState === 'hidden' && this.canLock()) this.locked.set(true);
    });
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
