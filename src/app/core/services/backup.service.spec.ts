import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { BackupService } from './backup.service';
import { SqliteDatabase } from '../data/sqlite-database';
import { NATIVE_EXPORT } from './native-export';
const native = { shareBackup: vi.fn() };

describe('Encrypted backup delivery', () => {
  const database = { exportBackupJson: vi.fn(), restoreBackupJson: vi.fn() };
  let service: BackupService;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    TestBed.configureTestingModule({
      providers: [
        { provide: SqliteDatabase, useValue: database },
        { provide: NATIVE_EXPORT, useValue: native },
      ],
    });
    service = TestBed.inject(BackupService);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it.each([true, false])(
    'creates and restores an encrypted backup with compression=%s without embedding its passphrase or plain preferences',
    async (compressed) => {
      if (!compressed) vi.stubGlobal('CompressionStream', undefined);
      const json = JSON.stringify({
        preferences: { sms_review_filters: { search: 'Synthetic saved search' } },
      });
      database.exportBackupJson.mockResolvedValue(json);
      const backup = await service.create('synthetic-backup-passphrase');
      expect(JSON.parse(backup.contents).version).toBe(compressed ? 2 : 1);
      expect(backup.contents).not.toContain('synthetic-backup-passphrase');
      expect(backup.contents).not.toContain('Synthetic saved search');
      await service.restore(backup.contents, 'synthetic-backup-passphrase');
      expect(database.restoreBackupJson).toHaveBeenCalledWith(json);
      await expect(service.restore(backup.contents, 'synthetic-wrong-passphrase')).rejects.toThrow(
        'incorrect',
      );
    },
  );
  it('opens native sharing only for the encrypted file supplied by the explicit share action', async () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue('android');
    native.shareBackup.mockResolvedValue(undefined);
    const content =
      '{"format":"cardnest-encrypted-backup","cipher":{"data":"synthetic-ciphertext"}}';
    expect(await service.share('synthetic.cnbak', content)).toBe(true);
    expect(native.shareBackup).toHaveBeenCalledWith({ filename: 'synthetic.cnbak', content });
  });
  it('keeps Android Save locally on the existing document-save bridge', async () => {
    const saveBackup = vi.fn(() =>
      queueMicrotask(() =>
        window.dispatchEvent(
          new CustomEvent('cardnest-native-result', {
            detail: { action: 'backup-saved', success: true },
          }),
        ),
      ),
    );
    Object.defineProperty(window, 'CardNestNative', { configurable: true, value: { saveBackup } });
    try {
      await service.save('synthetic.cnbak', 'synthetic-encrypted-file');
      expect(saveBackup).toHaveBeenCalledWith('synthetic.cnbak', btoa('synthetic-encrypted-file'));
      expect(native.shareBackup).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, 'CardNestNative');
    }
  });
  it('web share cancellation neither downloads a file nor reports successful sharing', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    try {
      expect(await service.share('synthetic.cnbak', 'encrypted')).toBe(false);
      expect(share).toHaveBeenCalledWith(expect.objectContaining({ files: [expect.any(File)] }));
    } finally {
      Reflect.deleteProperty(navigator, 'share');
      Reflect.deleteProperty(navigator, 'canShare');
    }
  });
  it('reports unsupported web sharing and lets the caller retain the file for local saving', async () => {
    await expect(service.share('synthetic.cnbak', 'encrypted')).rejects.toThrow('Save locally');
  });
  it('web Save locally downloads the encrypted file even when web sharing is available', async () => {
    const share = vi.fn();
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn().mockReturnValue('blob:synthetic'),
      revokeObjectURL: vi.fn(),
    });
    vi.useFakeTimers();
    try {
      await service.save('synthetic.cnbak', 'synthetic-encrypted-file');
      expect(names).toEqual(['synthetic.cnbak']);
      expect(share).not.toHaveBeenCalled();
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
      Reflect.deleteProperty(navigator, 'share');
    }
  });
});
