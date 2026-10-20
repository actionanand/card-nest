import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { SettingsPage } from './settings';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { BackupService } from '../../core/services/backup.service';
import { SnackbarService } from '../../core/services/snackbar.service';
import { ApplicationPinService } from '../../core/services/application-pin.service';
import { AppLockService } from '../../core/services/app-lock.service';

describe('Explicit backup destination choice', () => {
  const backup = { fileName: 'synthetic.cnbak', contents: 'synthetic-encrypted-file' };
  const backups = {
    create: vi.fn(),
    save: vi.fn(),
    share: vi.fn(),
    restore: vi.fn(),
    chooseBackup: vi.fn(),
    canShare: () => true,
  };
  beforeEach(() => {
    vi.resetAllMocks();
    backups.create.mockResolvedValue(backup);
    backups.save.mockResolvedValue(undefined);
    backups.share.mockResolvedValue(true);
    backups.chooseBackup.mockResolvedValue('synthetic-encrypted-file');
    backups.restore.mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        provideRouter([]),
        {
          provide: SqliteDatabase,
          useValue: {
            ready: signal(false),
            unavailableReason: signal(null),
            query: async () => [],
            run: async () => 0,
          },
        },
        { provide: BackupService, useValue: backups },
      ],
    });
  });
  const create = async () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.componentInstance.openCreateBackup();
    fixture.componentInstance.backupPassphrase.set('synthetic-passphrase');
    fixture.componentInstance.backupConfirmation.set('synthetic-passphrase');
    await fixture.componentInstance.submitBackup(new Event('submit'));
    return fixture;
  };
  it('creates once, clears credentials, and waits for a destination before doing any delivery', async () => {
    const fixture = await create();
    expect(fixture.componentInstance.pendingBackup()).toEqual(backup);
    expect(fixture.componentInstance.backupPassphrase()).toBe('');
    expect(fixture.componentInstance.backupConfirmation()).toBe('');
    expect(backups.save).not.toHaveBeenCalled();
    expect(backups.share).not.toHaveBeenCalled();
    await fixture.componentInstance.deliverBackup('SAVE');
    expect(backups.save).toHaveBeenCalledWith(backup.fileName, backup.contents);
    expect(fixture.componentInstance.pendingBackup()).toBeNull();
  });
  it('opens sharing only on Share Backup and does not claim a cloud save completed', async () => {
    const fixture = await create();
    const snackbar = vi.spyOn(TestBed.inject(SnackbarService), 'show');
    await fixture.componentInstance.deliverBackup('SHARE');
    expect(backups.share).toHaveBeenCalledWith(backup.fileName, backup.contents);
    expect(backups.save).not.toHaveBeenCalled();
    expect(snackbar).toHaveBeenCalledWith(
      'Backup sharing opened. Finish saving in the selected app.',
      'INFO',
    );
  });
  it('retains the encrypted file for retry after failure or cancelled web sharing', async () => {
    const fixture = await create();
    backups.share.mockRejectedValueOnce(new Error('Synthetic failure'));
    await fixture.componentInstance.deliverBackup('SHARE');
    expect(fixture.componentInstance.deliveryError()).toBe('Synthetic failure');
    expect(fixture.componentInstance.pendingBackup()).toEqual(backup);
    backups.share.mockResolvedValueOnce(false);
    await fixture.componentInstance.deliverBackup('SHARE');
    expect(fixture.componentInstance.pendingBackup()).toEqual(backup);
    fixture.componentInstance.closeBackupDelivery();
    expect(fixture.componentInstance.pendingBackup()).toBeNull();
  });
  it('does not create a backup after an incorrect application PIN', async () => {
    const fixture = TestBed.createComponent(SettingsPage);
    const pin = TestBed.inject(ApplicationPinService);
    pin.hasPin.set(true);
    vi.spyOn(pin, 'verifyPin').mockResolvedValue(false);
    await fixture.componentInstance.submitBackup(new Event('submit'));
    expect(backups.create).not.toHaveBeenCalled();
    expect(fixture.componentInstance.pendingBackup()).toBeNull();
  });
  it('guards repeated delivery taps and discards the pending file when the application locks', async () => {
    const fixture = await create();
    let finish: () => void = () => undefined;
    backups.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = fixture.componentInstance.deliverBackup('SAVE');
    await fixture.componentInstance.deliverBackup('SAVE');
    expect(backups.save).toHaveBeenCalledOnce();
    finish();
    await first;
    fixture.componentInstance.pendingBackup.set(backup);
    TestBed.inject(AppLockService).locked.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.pendingBackup()).toBeNull();
  });
  it('keeps restore behind explicit confirmation and clears credentials only after the restore receives them', async () => {
    const fixture = TestBed.createComponent(SettingsPage);
    await fixture.componentInstance.openRestoreBackup();
    fixture.componentInstance.backupPassphrase.set('synthetic-restore-passphrase');
    await fixture.componentInstance.submitBackup(new Event('submit'));
    expect(fixture.componentInstance.restoreConfirmationOpen()).toBe(true);
    expect(backups.restore).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      await fixture.componentInstance.confirmRestoreBackup();
      expect(backups.restore).toHaveBeenCalledWith(
        'synthetic-encrypted-file',
        'synthetic-restore-passphrase',
      );
      expect(fixture.componentInstance.backupPassphrase()).toBe('');
      expect(fixture.componentInstance.restoreConfirmationOpen()).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
