import { Service, inject, signal } from '@angular/core';
import { SqliteDatabase } from '../data/sqlite-database';

interface StoredPinHash {
  readonly version: 1;
  readonly salt: string;
  readonly hash: string;
  readonly iterations: number;
}

const PIN_PREFERENCE_KEY = 'security_pin_hash';
const PIN_ITERATIONS = 210_000;

@Service()
export class ApplicationPinService {
  private readonly database = inject(SqliteDatabase);
  private storedHash: StoredPinHash | null = null;
  readonly hasPin = signal(false);

  async initialise(): Promise<void> {
    if (!this.database.ready()) return;
    const rows = await this.database.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key = ?',
      [PIN_PREFERENCE_KEY],
    );
    const value = rows[0]?.encrypted_value;
    if (!value) return;
    try {
      const parsed = JSON.parse(value) as Partial<StoredPinHash>;
      if (
        parsed.version === 1 &&
        typeof parsed.salt === 'string' &&
        typeof parsed.hash === 'string' &&
        typeof parsed.iterations === 'number'
      ) {
        this.storedHash = parsed as StoredPinHash;
        this.hasPin.set(true);
      }
    } catch {
      this.storedHash = null;
      this.hasPin.set(false);
    }
  }

  async changePin(currentPin: string, newPin: string): Promise<boolean> {
    if (!this.database.ready()) throw new Error('SQLite storage is unavailable.');
    if (this.storedHash && !(await this.verify(currentPin))) return false;

    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const hashBytes = await this.derive(newPin, saltBytes, PIN_ITERATIONS);
    const stored: StoredPinHash = {
      version: 1,
      salt: this.toBase64(saltBytes),
      hash: this.toBase64(hashBytes),
      iterations: PIN_ITERATIONS,
    };
    await this.database.run(
      `INSERT INTO app_preferences (key, encrypted_value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value`,
      [PIN_PREFERENCE_KEY, JSON.stringify(stored)],
    );
    this.storedHash = stored;
    this.hasPin.set(true);
    return true;
  }

  private async verify(pin: string): Promise<boolean> {
    if (!this.storedHash) return false;
    const expected = this.fromBase64(this.storedHash.hash);
    const actual = await this.derive(
      pin,
      this.fromBase64(this.storedHash.salt),
      this.storedHash.iterations,
    );
    if (actual.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < actual.length; index += 1) {
      difference |= actual[index] ^ expected[index];
    }
    return difference === 0;
  }

  private async derive(
    pin: string,
    salt: Uint8Array<ArrayBuffer>,
    iterations: number,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(pin),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material,
      256,
    );
    return new Uint8Array(bits);
  }

  private toBase64(value: Uint8Array): string {
    return btoa(String.fromCharCode(...value));
  }

  private fromBase64(value: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  }
}
