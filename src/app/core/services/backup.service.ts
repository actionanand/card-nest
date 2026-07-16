import { DOCUMENT } from '@angular/common';
import { inject, Service } from '@angular/core';
import { SqliteDatabase } from '../data/sqlite-database';

interface NativeBackupBridge {
  openBackup(): void;
  saveBackup(fileName: string, base64Data: string): void;
}

interface NativeBackupWindow extends Window {
  CardNestNative?: NativeBackupBridge;
}

interface EncryptedBackup {
  readonly format: 'cardnest-encrypted-backup';
  readonly version: 1;
  readonly createdAt: string;
  readonly kdf: {
    readonly algorithm: 'PBKDF2-SHA256';
    readonly iterations: number;
    readonly salt: string;
  };
  readonly cipher: { readonly algorithm: 'AES-GCM'; readonly iv: string; readonly data: string };
}

const BACKUP_ITERATIONS = 310_000;

@Service()
export class BackupService {
  private readonly document = inject(DOCUMENT);
  private readonly database = inject(SqliteDatabase);

  async create(passphrase: string): Promise<{ fileName: string; contents: string }> {
    this.validatePassphrase(passphrase);
    const databaseJson = await this.database.exportBackupJson();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveKey(passphrase, salt, BACKUP_ITERATIONS);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(databaseJson),
    );
    const backup: EncryptedBackup = {
      format: 'cardnest-encrypted-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      kdf: {
        algorithm: 'PBKDF2-SHA256',
        iterations: BACKUP_ITERATIONS,
        salt: this.toBase64(salt),
      },
      cipher: {
        algorithm: 'AES-GCM',
        iv: this.toBase64(iv),
        data: this.toBase64(new Uint8Array(encrypted)),
      },
    };
    return {
      fileName: `cardnest-backup-${new Date().toISOString().slice(0, 10)}.cnbak`,
      contents: JSON.stringify(backup),
    };
  }

  async save(fileName: string, contents: string): Promise<void> {
    const nativeBridge = (this.document.defaultView as NativeBackupWindow | null)?.CardNestNative;
    if (nativeBridge) {
      await this.waitForNativeResult('backup-saved', () =>
        nativeBridge.saveBackup(fileName, this.toBase64(new TextEncoder().encode(contents))),
      );
      return;
    }
    const file = new File([contents], fileName, { type: 'application/json' });
    const navigatorWithShare = this.document.defaultView?.navigator as Navigator & {
      canShare?: (data: ShareData) => boolean;
    };
    if (navigatorWithShare?.share && navigatorWithShare.canShare?.({ files: [file] })) {
      try {
        await navigatorWithShare.share({ files: [file], title: 'CardNest encrypted backup' });
        return;
      } catch {
        // Browsers can expose file sharing but reject it because of permissions or policy.
        // Continue to the normal download path so web backup remains available.
      }
    }
    const url = URL.createObjectURL(file);
    const anchor = this.document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    this.document.body.append(anchor);
    anchor.click();
    anchor.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  async chooseBackup(): Promise<string> {
    const nativeBridge = (this.document.defaultView as NativeBackupWindow | null)?.CardNestNative;
    if (nativeBridge) {
      const data = await this.waitForNativeResult('backup-opened', () => nativeBridge.openBackup());
      return new TextDecoder().decode(this.fromBase64(data));
    }
    return new Promise<string>((resolve, reject) => {
      const input = this.document.createElement('input');
      input.type = 'file';
      input.accept = '.cnbak,application/json';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) {
          reject(new Error('No backup file was selected.'));
          return;
        }
        void file.text().then(resolve, reject);
      });
      input.click();
    });
  }

  async restore(contents: string, passphrase: string): Promise<void> {
    this.validatePassphrase(passphrase);
    const parsed = JSON.parse(contents) as Partial<EncryptedBackup>;
    if (
      parsed.format !== 'cardnest-encrypted-backup' ||
      parsed.version !== 1 ||
      parsed.kdf?.algorithm !== 'PBKDF2-SHA256' ||
      parsed.cipher?.algorithm !== 'AES-GCM'
    ) {
      throw new Error('This is not a supported CardNest backup.');
    }
    try {
      const key = await this.deriveKey(
        passphrase,
        this.fromBase64(parsed.kdf.salt),
        parsed.kdf.iterations,
      );
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this.fromBase64(parsed.cipher.iv) },
        key,
        this.fromBase64(parsed.cipher.data),
      );
      await this.database.restoreBackupJson(new TextDecoder().decode(decrypted));
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('backup database')) throw error;
      throw new Error('The backup passphrase is incorrect or the file is damaged.', {
        cause: error,
      });
    }
  }

  private async deriveKey(
    passphrase: string,
    salt: Uint8Array<ArrayBuffer>,
    iterations: number,
  ): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  private waitForNativeResult(action: string, start: () => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const handleResult = (event: Event) => {
        const detail = (
          event as CustomEvent<{
            action: string;
            success: boolean;
            data?: string;
            message?: string;
          }>
        ).detail;
        if (detail.action !== action) return;
        this.document.defaultView?.removeEventListener('cardnest-native-result', handleResult);
        if (detail.success) resolve(detail.data ?? '');
        else reject(new Error(detail.message ?? 'The file operation was cancelled.'));
      };
      this.document.defaultView?.addEventListener('cardnest-native-result', handleResult);
      start();
    });
  }

  private validatePassphrase(passphrase: string): void {
    if (passphrase.length < 8) throw new Error('Use a backup passphrase of at least 8 characters.');
  }

  private toBase64(value: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < value.length; offset += 0x8000) {
      binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  private fromBase64(value: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  }
}
