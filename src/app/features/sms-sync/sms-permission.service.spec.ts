// Non-isolated workers may have cached SmsReviewService bound to the real Capacitor
// (e.g. sqlite-backup.integration.spec). Reset so it re-imports the mocked bridge below.
vi.hoisted(() => {
  vi.resetModules();
});
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { SmsReviewService } from './sms-review.service';
import { ScanStatus } from './sms-model';
import { SqliteDatabase } from '../../core/data/sqlite-database';
import { CardNestStore } from '../../core/services/card-nest-store';
import { AppLockService } from '../../core/services/app-lock.service';

const native = vi.hoisted(() => ({
  status: vi.fn(),
  enable: vi.fn(),
  openSettings: vi.fn(),
  beginScan: vi.fn(),
  scanPage: vi.fn(),
  pending: vi.fn(),
  catchUp: vi.fn(),
  disable: vi.fn(),
}));
const capacitor = vi.hoisted(() => ({
  getPlatform: vi.fn<() => string>(() => 'android'),
}));
vi.mock('@capacitor/core', () => {
  return { Capacitor: capacitor, registerPlugin: () => native };
});

describe('SMS permission interaction through the native bridge', () => {
  let service: SmsReviewService;
  const denied: ScanStatus = {
    permission: 'denied',
    enabled: false,
    cursorDate: 42,
    cursorId: 17,
    completedAt: 0,
    pages: 4,
    scanned: 800,
    found: 9,
    more: true,
    error: '',
    backgroundPending: false,
    permissionMessage: 'Both SMS permissions are needed.',
  };
  const granted: ScanStatus = {
    ...denied,
    permission: 'granted',
    enabled: true,
    readGranted: true,
    receiveGranted: true,
    backgroundPending: true,
  };
  const database = { atomic: vi.fn(), run: vi.fn(), query: vi.fn() };
  let locked = signal(false);
  let foreground = signal(true);
  beforeEach(() => {
    vi.clearAllMocks();
    capacitor.getPlatform.mockReturnValue('android');
    native.status.mockResolvedValue(denied);
    native.enable.mockResolvedValue(denied);
    native.pending.mockResolvedValue({ items: [] });
    native.disable.mockResolvedValue({ ...granted, enabled: false });
    locked = signal(false);
    foreground = signal(true);
    TestBed.configureTestingModule({
      providers: [
        SmsReviewService,
        { provide: SqliteDatabase, useValue: database },
        { provide: CardNestStore, useValue: {} },
        { provide: AppLockService, useValue: { locked, foreground } },
      ],
    });
    service = TestBed.inject(SmsReviewService);
    expect(Capacitor).toBe(capacitor);
    expect(Capacitor.getPlatform()).toBe('android');
    expect(service.lock.locked).toBe(locked);
    expect(service.lock.foreground).toBe(foreground);
    expect(service.lock.locked()).toBe(false);
    expect(service.lock.foreground()).toBe(true);
  });
  it('the service itself observes the mocked Android platform and native bridge', async () => {
    await service.refreshAccess();
    expect(capacitor.getPlatform).toHaveBeenCalled();
    expect(native.status).toHaveBeenCalledOnce();
    expect(service.status()?.permission).toBe('denied');
  });
  it.each([
    ['web platform', () => capacitor.getPlatform.mockReturnValue('web')],
    ['locked app', () => locked.set(true)],
    ['backgrounded app', () => foreground.set(false)],
  ] as const)('a %s cannot reach the SMS bridge', async (_label, restrict) => {
    restrict();
    await expect(service.refreshAccess()).rejects.toThrow('Unlock CardNest on Android');
    await expect(service.enterFromReview(30)).rejects.toThrow('Unlock CardNest on Android');
    await expect(service.enable(30)).rejects.toThrow('Unlock CardNest on Android');
    expect(native.status).not.toHaveBeenCalled();
    expect(native.enable).not.toHaveBeenCalled();
    expect(service.status()).toBeNull();
  });
  it('first opening and restart read live status without requesting or changing financial data', async () => {
    native.status.mockResolvedValue({ ...denied, permission: 'not requested' });
    await service.refreshAccess();
    expect(service.status()?.permission).toBe('not requested');
    expect(native.status).toHaveBeenCalledOnce();
    expect(native.enable).not.toHaveBeenCalled();
    expect(database.atomic).not.toHaveBeenCalled();
    expect(database.run).not.toHaveBeenCalled();
  });
  it('deliberate first Review entry reads actual permission and requests once, even for concurrent entries', async () => {
    native.status.mockResolvedValue({ ...denied, permission: 'not requested' });
    native.enable.mockResolvedValue(granted);
    await Promise.all([service.enterFromReview(30), service.enterFromReview(30)]);
    expect(native.status).toHaveBeenCalled();
    expect(native.enable).toHaveBeenCalledOnce();
    expect(service.syncEnabled()).toBe(true);
    await service.enterFromReview(30);
    expect(native.enable).toHaveBeenCalledOnce();
    expect(database.atomic).not.toHaveBeenCalled();
    expect(native.beginScan).not.toHaveBeenCalled();
  });
  it.each(['denied', 'revoked', 'unavailable', 'granted'])(
    'Review entry does not request again for %s access or re-enable an explicit opt-out',
    async (permission) => {
      native.status.mockResolvedValue({ ...denied, permission, enabled: false });
      await service.enterFromReview(30);
      await service.enterFromReview(30);
      expect(native.enable).not.toHaveBeenCalled();
      expect(service.syncEnabled()).toBe(false);
    },
  );
  it('a failed first-entry request is not repeated on later navigation; explicit ON can retry', async () => {
    native.status.mockResolvedValue({ ...denied, permission: 'not requested' });
    native.enable.mockRejectedValue(new Error('Synthetic request failure'));
    await service.enterFromReview(30);
    await service.enterFromReview(30);
    expect(native.enable).toHaveBeenCalledOnce();
    expect(service.syncEnabled()).toBe(false);
    native.enable.mockResolvedValue(granted);
    await service.enable(30);
    expect(service.syncEnabled()).toBe(true);
    expect(native.enable).toHaveBeenCalledTimes(2);
  });
  it('OFF cancels discovery through native disable, immediately blocks Scan and retains progress/financial data', async () => {
    service.status.set(granted);
    service.busy.set(true);
    let finish!: (status: ScanStatus) => void;
    native.disable.mockReturnValue(
      new Promise<ScanStatus>((resolve) => {
        finish = resolve;
      }),
    );
    const disable = service.disable();
    expect(service.changingSync()).toBe(true);
    expect(service.canScan()).toBe(false);
    finish({ ...granted, enabled: false });
    await disable;
    expect(service.status()).toMatchObject({
      permission: 'granted',
      enabled: false,
      cursorDate: 42,
      cursorId: 17,
      pages: 4,
    });
    expect(service.syncEnabled()).toBe(false);
    expect(service.canScan()).toBe(false);
    expect(database.atomic).not.toHaveBeenCalled();
    expect(database.run).not.toHaveBeenCalled();
  });
  it('only explicit Enable invokes the real bridge request and preserves denied progress', async () => {
    await service.enable(30);
    expect(native.enable).toHaveBeenCalledWith(
      expect.objectContaining({ batch: 200, since: expect.any(Number) }),
    );
    expect(service.canScan()).toBe(false);
    expect(service.status()?.cursorId).toBe(17);
    expect(service.error()).toContain('Both SMS');
    expect(native.beginScan).not.toHaveBeenCalled();
    expect(database.atomic).not.toHaveBeenCalled();
  });
  it('a confirmed grant enables scanning without automatically starting it or importing', async () => {
    native.enable.mockResolvedValue(granted);
    await service.enable(30);
    expect(service.canScan()).toBe(true);
    expect(native.beginScan).not.toHaveBeenCalled();
    expect(database.atomic).not.toHaveBeenCalled();
  });
  it('deduplicates repeated Enable taps until the request resolves', async () => {
    let finish: (value: ScanStatus) => void = () => {
      throw new Error('No request');
    };
    native.enable.mockReturnValue(
      new Promise<ScanStatus>((resolve) => {
        finish = resolve;
      }),
    );
    const first = service.enable(30);
    await service.enable(90);
    expect(native.enable).toHaveBeenCalledOnce();
    expect(service.requestingPermission()).toBe(true);
    finish(denied);
    await first;
    expect(service.requestingPermission()).toBe(false);
  });
  it('does not overwrite a confirmed grant with an older status response from permission-dialog focus', async () => {
    let finish: (value: ScanStatus) => void = () => {
      throw new Error('No status request');
    };
    native.status.mockReturnValue(
      new Promise<ScanStatus>((resolve) => {
        finish = resolve;
      }),
    );
    const oldStatus = service.refreshAccess();
    native.enable.mockResolvedValue(granted);
    await service.enable(30);
    finish(denied);
    await oldStatus;
    expect(service.status()?.permission).toBe('granted');
    expect(service.canScan()).toBe(true);
  });
  it('exposes rejected or no-dialog requests as actionable failures, never successful enables', async () => {
    native.enable.mockRejectedValue(new Error('Android request unavailable; check app settings.'));
    await service.enable(30);
    expect(service.error()).toContain('check app settings');
    expect(service.canScan()).toBe(false);
    expect(service.requestingPermission()).toBe(false);
  });
  it('returns from settings with live grants but preserves disabled-by-user opt-in', async () => {
    await service.enable(30);
    expect(service.error()).not.toBe('');
    native.enable.mockClear();
    await service.openSettings();
    expect(native.openSettings).toHaveBeenCalledOnce();
    native.status.mockResolvedValue({ ...granted, enabled: false });
    await service.refreshAccess();
    expect(service.status()?.permission).toBe('granted');
    expect(service.canScan()).toBe(false);
    expect(service.error()).toBe('');
    expect(native.enable).not.toHaveBeenCalled();
  });
  it('rechecks revocation before resuming and never begins denied work', async () => {
    service.status.set(granted);
    native.status.mockResolvedValue({ ...denied, permission: 'revoked' });
    await service.scan();
    expect(service.canScan()).toBe(false);
    expect(native.beginScan).not.toHaveBeenCalled();
    expect(native.catchUp).not.toHaveBeenCalled();
    expect(database.atomic).not.toHaveBeenCalled();
  });
  it('refreshes permission after an in-flight scan rejection and stops catch-up', async () => {
    native.status
      .mockResolvedValueOnce(granted)
      .mockResolvedValue({ ...denied, permission: 'revoked' });
    native.scanPage.mockRejectedValue(new Error('SMS permission revoked'));
    await service.scan();
    expect(native.beginScan).toHaveBeenCalledOnce();
    expect(service.canScan()).toBe(false);
    expect(service.error()).toContain('revoked');
    expect(native.catchUp).not.toHaveBeenCalled();
    expect(database.atomic).not.toHaveBeenCalled();
  });
});
