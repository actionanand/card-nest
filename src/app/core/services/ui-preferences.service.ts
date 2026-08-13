import { Service, effect, signal } from '@angular/core';

interface NativePrivacyBridge {
  setScreenSecure(enabled: boolean): void;
}

interface NativePrivacyWindow extends Window {
  CardNestNative?: NativePrivacyBridge;
}

const FLASH_VISIBLE_KEY = 'cardnest_flash_transaction_visible';
const SCREEN_SECURE_KEY = 'cardnest_prevent_screenshots';
const CARDS_FILTER_KEY = 'cardnest_cards_filter';
const CARDS_SORT_KEY = 'cardnest_cards_sort';
const CARDS_DUE_GENERATED_KEY = 'cardnest_cards_due_generated';

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
  readonly showFlashTransaction = signal(readBoolean(FLASH_VISIBLE_KEY, true));
  readonly preventScreenshots = signal(readBoolean(SCREEN_SECURE_KEY, false));
  readonly cardsFilter = signal(readString(CARDS_FILTER_KEY, 'ALL'));
  readonly cardsSort = signal(readString(CARDS_SORT_KEY, 'NAME'));
  readonly cardsDueBillGeneratedOnly = signal(readBoolean(CARDS_DUE_GENERATED_KEY, true));

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
