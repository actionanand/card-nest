import { Service, effect, signal } from '@angular/core';

interface NativePrivacyBridge {
  setScreenSecure(enabled: boolean): void;
}

interface NativePrivacyWindow extends Window {
  CardNestNative?: NativePrivacyBridge;
}

const FLASH_VISIBLE_KEY = 'cardnest_flash_transaction_visible';
const SCREEN_SECURE_KEY = 'cardnest_prevent_screenshots';

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return value === null || value === undefined ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

@Service()
export class UiPreferencesService {
  readonly showFlashTransaction = signal(readBoolean(FLASH_VISIBLE_KEY, true));
  readonly preventScreenshots = signal(readBoolean(SCREEN_SECURE_KEY, false));

  constructor() {
    effect(() => {
      (globalThis.window as NativePrivacyWindow | undefined)?.CardNestNative?.setScreenSecure(
        this.preventScreenshots(),
      );
    });
  }

  setShowFlashTransaction(visible: boolean): void {
    this.showFlashTransaction.set(visible);
    this.persist(FLASH_VISIBLE_KEY, visible);
  }

  setPreventScreenshots(enabled: boolean): void {
    this.preventScreenshots.set(enabled);
    this.persist(SCREEN_SECURE_KEY, enabled);
  }

  private persist(key: string, value: boolean): void {
    try {
      globalThis.localStorage?.setItem(key, String(value));
    } catch {
      // The in-memory preference remains active when browser storage is unavailable.
    }
  }
}
