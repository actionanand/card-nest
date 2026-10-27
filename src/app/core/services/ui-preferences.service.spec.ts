import { TestBed } from '@angular/core/testing';
import { EnvironmentInjector, runInInjectionContext } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { UiPreferencesService } from './ui-preferences.service';

const LEGACY_KEY = 'cardnest_flash_transaction_visible';
const CONFIG_KEY = 'cardnest_floating_shortcut_v1';

describe('Android floating shortcut preferences', () => {
  let nativePlatform = true;
  let platform = 'android';

  beforeEach(() => {
    localStorage.clear();
    nativePlatform = true;
    platform = 'android';
    vi.spyOn(Capacitor, 'isNativePlatform').mockImplementation(() => nativePlatform);
    vi.spyOn(Capacitor, 'getPlatform').mockImplementation(() => platform);
    TestBed.configureTestingModule({ providers: [UiPreferencesService] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('migrates an enabled legacy Flash shortcut to Quick Transaction and retains the old key', () => {
    localStorage.setItem(LEGACY_KEY, 'true');
    const preferences = TestBed.inject(UiPreferencesService);
    expect(preferences.androidNative).toBe(true);
    expect(preferences.floatingShortcut()).toEqual({ enabled: true, mode: 'QUICK_TRANSACTION' });
    expect(preferences.showFlashTransaction()).toBe(true);
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null')).toEqual({
      enabled: true,
      mode: 'QUICK_TRANSACTION',
    });
    expect(localStorage.getItem(LEGACY_KEY)).toBe('true');
  });

  it('preserves an explicitly disabled legacy shortcut and a stored SMS Sync selection across restart', () => {
    localStorage.setItem(LEGACY_KEY, 'false');
    const preferences = TestBed.inject(UiPreferencesService);
    expect(preferences.floatingShortcut()).toEqual({ enabled: false, mode: 'QUICK_TRANSACTION' });
    expect(preferences.setFloatingShortcutMode('SMS_SYNC')).toBe(true);
    expect(preferences.setFloatingShortcutEnabled(true)).toBe(true);
    expect(preferences.showFlashTransaction()).toBe(false);
    expect(localStorage.getItem(LEGACY_KEY)).toBe('false');

    const restarted = runInInjectionContext(
      TestBed.inject(EnvironmentInjector),
      () => new UiPreferencesService(),
    );
    expect(restarted.floatingShortcut()).toEqual({ enabled: true, mode: 'SMS_SYNC' });
    expect(restarted.showFlashTransaction()).toBe(false);
    expect(restarted.setFloatingShortcutMode('QUICK_TRANSACTION')).toBe(true);
    expect(localStorage.getItem(LEGACY_KEY)).toBe('true');
  });

  it('uses the documented Quick Transaction default for a fresh Android install', () => {
    const preferences = TestBed.inject(UiPreferencesService);
    expect(preferences.floatingShortcut()).toEqual({ enabled: true, mode: 'QUICK_TRANSACTION' });
    expect(preferences.showFlashTransaction()).toBe(true);
  });

  it('normalizes corrupt stored state through the legacy default without losing its value', () => {
    localStorage.setItem(LEGACY_KEY, 'false');
    localStorage.setItem(CONFIG_KEY, '{bad json');
    const preferences = TestBed.inject(UiPreferencesService);
    expect(preferences.floatingShortcut()).toEqual({ enabled: false, mode: 'QUICK_TRANSACTION' });
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null')).toEqual({
      enabled: false,
      mode: 'QUICK_TRANSACTION',
    });
    expect(localStorage.getItem(LEGACY_KEY)).toBe('false');
  });

  it.each([
    ['Android Chrome', false, 'web'],
    ['Desktop web', false, 'web'],
    ['iOS native', true, 'ios'],
  ])('does not expose or allow writes on %s', (_label, native, os) => {
    nativePlatform = native;
    platform = os;
    const preferences = TestBed.inject(UiPreferencesService);
    expect(preferences.androidNative).toBe(false);
    expect(preferences.showFlashTransaction()).toBe(false);
    expect(preferences.setFloatingShortcutEnabled(true)).toBe(false);
    expect(preferences.setFloatingShortcutMode('SMS_SYNC')).toBe(false);
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
  });

  it('does not update the in-memory mode when persistence fails', () => {
    const preferences = TestBed.inject(UiPreferencesService);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Synthetic local storage failure');
    });
    expect(preferences.setFloatingShortcutMode('SMS_SYNC')).toBe(false);
    expect(preferences.floatingShortcutMode()).toBe('QUICK_TRANSACTION');
  });
});
