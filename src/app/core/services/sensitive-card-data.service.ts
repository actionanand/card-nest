import { Service, inject } from '@angular/core';
import { SqliteDatabase } from '../data/sqlite-database';

interface CipherPayload {
  readonly version: 1;
  readonly iv: string;
  readonly ciphertext: string;
}

const MASTER_KEY_PREFERENCE = 'card_secret_master_key_v1';

@Service()
export class SensitiveCardDataService {
  private readonly database = inject(SqliteDatabase);
  private keyBytes: Uint8Array<ArrayBuffer> | null = null;

  async initialise(): Promise<void> {
    if (!this.database.ready()) return;
    const rows = await this.database.query<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM app_preferences WHERE key = ?',
      [MASTER_KEY_PREFERENCE],
    );
    const stored = rows[0]?.encrypted_value;
    if (stored) {
      this.keyBytes = this.fromBase64(stored);
      return;
    }
    this.keyBytes = crypto.getRandomValues(new Uint8Array(32));
    await this.database.run('INSERT INTO app_preferences (key, encrypted_value) VALUES (?, ?)', [
      MASTER_KEY_PREFERENCE,
      this.toBase64(this.keyBytes),
    ]);
  }

  async encrypt(value: string): Promise<string> {
    const key = await this.key();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(value),
    );
    const payload: CipherPayload = {
      version: 1,
      iv: this.toBase64(iv),
      ciphertext: this.toBase64(new Uint8Array(ciphertext)),
    };
    return JSON.stringify(payload);
  }

  async decrypt(value: string): Promise<string> {
    const payload = JSON.parse(value) as CipherPayload;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.fromBase64(payload.iv) },
      await this.key(),
      this.fromBase64(payload.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  }

  private async key(): Promise<CryptoKey> {
    if (!this.keyBytes) await this.initialise();
    if (!this.keyBytes) throw new Error('Card secret storage is unavailable.');
    return crypto.subtle.importKey('raw', this.keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  private toBase64(value: Uint8Array): string {
    return btoa(String.fromCharCode(...value));
  }

  private fromBase64(value: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  }
}
