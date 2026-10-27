import { Service, computed, effect, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

interface NativePrivacyBridge {
  setScreenSecure(enabled: boolean): void;
}

interface NativePrivacyWindow extends Window {
  CardNestNative?: NativePrivacyBridge;
}

const FLASH_VISIBLE_KEY = 'cardnest_flash_transaction_visible';
const FLOATING_SHORTCUT_KEY = 'cardnest_floating_shortcut_v1';
const SCREEN_SECURE_KEY = 'cardnest_prevent_screenshots';
const CARDS_FILTER_KEY = 'cardnest_cards_filter';
const CARDS_SORT_KEY = 'cardnest_cards_sort';
const CARDS_DUE_GENERATED_KEY = 'cardnest_cards_due_generated';

export type FloatingShortcutMode = 'QUICK_TRANSACTION' | 'SMS_SYNC';

export interface FloatingShortcutPreference {
  readonly enabled: boolean;
  readonly mode: FloatingShortcutMode;
}

function parseFloatingShortcut(value: unknown): FloatingShortcutPreference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record['enabled'] !== 'boolean' ||
    (record['mode'] !== 'QUICK_TRANSACTION' && record['mode'] !== 'SMS_SYNC')
  )
    return undefined;
  return { enabled: record['enabled'], mode: record['mode'] };
}

function readFloatingShortcut(): FloatingShortcutPreference {
  try {
    const stored = globalThis.localStorage?.getItem(FLOATING_SHORTCUT_KEY);
    if (stored !== null && stored !== undefined) {
      try {
        const preference = parseFloatingShortcut(JSON.parse(stored));
        if (preference) return preference;
      } catch {
        // Fall back to the old Flash preference below.
      }
    }
  } catch {
    // Continue with the legacy preference's safe default.
  }
  return {
    enabled: readBoolean(FLASH_VISIBLE_KEY, true),
    mode: 'QUICK_TRANSACTION',
  };
}

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return value === null || value === undefined ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

function readString(key: string, fallback: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

@Service()
export class UiPreferencesService {
  readonly androidNative =
    Capacitor.isNativePlatform?.() === true && Capacitor.getPlatform() === 'android';
  readonly floatingShortcut = signal<FloatingShortcutPreference>({
    enabled: true,
    mode: 'QUICK_TRANSACTION',
  });
  readonly floatingShortcutEnabled = computed(() => this.floatingShortcut().enabled);
  readonly floatingShortcutMode = computed(() => this.floatingShortcut().mode);
  readonly showFlashTransaction = computed(
    () =>
      this.androidNative &&
      this.floatingShortcutEnabled() &&
      this.floatingShortcutMode() === 'QUICK_TRANSACTION',
  );
  readonly preventScreenshots = signal(readBoolean(SCREEN_SECURE_KEY, false));
  readonly cardsFilter = signal(readString(CARDS_FILTER_KEY, 'ALL'));
  readonly cardsSort = signal(readString(CARDS_SORT_KEY, 'NAME'));
  readonly cardsDueBillGeneratedOnly = signal(readBoolean(CARDS_DUE_GENERATED_KEY, true));

  constructor() {
    const restored = readFloatingShortcut();
    this.floatingShortcut.set(restored);
    if (this.androidNative) this.persistFloatingShortcut(restored);
    effect(() => {
      (globalThis.window as NativePrivacyWindow | undefined)?.CardNestNative?.setScreenSecure(
        this.preventScreenshots(),
      );
    });
  }

  setShowFlashTransaction(visible: boolean): void {
    this.setFloatingShortcutEnabled(visible);
  }

  setFloatingShortcutEnabled(enabled: boolean): boolean {
    return this.persistFloatingShortcut({ ...this.floatingShortcut(), enabled });
  }

  setFloatingShortcutMode(mode: FloatingShortcutMode): boolean {
    if (mode !== 'QUICK_TRANSACTION' && mode !== 'SMS_SYNC') return false;
    return this.persistFloatingShortcut({ ...this.floatingShortcut(), mode });
  }

  private persistFloatingShortcut(preference: FloatingShortcutPreference): boolean {
    if (!this.androidNative) return false;
    const configValue = JSON.stringify(preference);
    const legacyValue = String(preference.enabled && preference.mode === 'QUICK_TRANSACTION');
    try {
      const storage = globalThis.localStorage;
      if (!storage) return false;
      const previousConfig = storage.getItem(FLOATING_SHORTCUT_KEY);
      const previousLegacy = storage.getItem(FLASH_VISIBLE_KEY);
      storage.setItem(FLOATING_SHORTCUT_KEY, configValue);
      try {
        storage.setItem(FLASH_VISIBLE_KEY, legacyValue);
      } catch (error: unknown) {
        if (previousConfig === null) storage.removeItem(FLOATING_SHORTCUT_KEY);
        else storage.setItem(FLOATING_SHORTCUT_KEY, previousConfig);
        if (previousLegacy === null) storage.removeItem(FLASH_VISIBLE_KEY);
        else storage.setItem(FLASH_VISIBLE_KEY, previousLegacy);
        throw error;
      }
      this.floatingShortcut.set(preference);
      return true;
    } catch {
      return false;
    }
  }

  setPreventScreenshots(enabled: boolean): void {
    this.preventScreenshots.set(enabled);
    this.persist(SCREEN_SECURE_KEY, enabled);
  }

  setCardsFilter(value: string): void {
    this.cardsFilter.set(value);
    this.persistValue(CARDS_FILTER_KEY, value);
  }

  setCardsSort(value: string): void {
    this.cardsSort.set(value);
    this.persistValue(CARDS_SORT_KEY, value);
  }

  setCardsDueBillGeneratedOnly(value: boolean): void {
    this.cardsDueBillGeneratedOnly.set(value);
    this.persist(CARDS_DUE_GENERATED_KEY, value);
  }

  private persistValue(key: string, value: string): void {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // The in-memory preference remains active when browser storage is unavailable.
    }
  }

  private persist(key: string, value: boolean): void {
    try {
      globalThis.localStorage?.setItem(key, String(value));
    } catch {
      // The in-memory preference remains active when browser storage is unavailable.
    }
  }
}
