import { DOCUMENT } from '@angular/common';
import { Service, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { normalizeIndianMobileNumber } from './utilities.service';

export type WhatsAppPackage = 'com.whatsapp' | 'com.whatsapp.w4b';
export type WhatsAppOpenResult = 'OPENED' | 'CHOOSER' | 'BROWSER_FALLBACK' | 'INVALID' | 'BLOCKED';

interface WhatsAppBridge {
  availableWhatsAppApps(): string;
  openWhatsAppIn(number: string, message: string, packageName: string): void;
  openWhatsAppFallback(number: string, message: string): void;
}

interface WhatsAppWindow extends Window {
  CardNestNative?: WhatsAppBridge;
}

const KNOWN_PACKAGES: readonly WhatsAppPackage[] = ['com.whatsapp', 'com.whatsapp.w4b'];

@Service()
export class WhatsAppService {
  private readonly document = inject(DOCUMENT);

  open(
    number: string | undefined,
    message = '',
  ): {
    readonly result: WhatsAppOpenResult;
    readonly packages: readonly WhatsAppPackage[];
  } {
    if (!number) return { result: 'INVALID', packages: [] };
    let normalized: string;
    try {
      normalized = normalizeIndianMobileNumber(number) ?? '';
    } catch {
      return { result: 'INVALID', packages: [] };
    }
    if (!normalized) return { result: 'INVALID', packages: [] };
    const digits = normalized.replace(/\D/g, '');
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      const bridge = (this.document.defaultView as WhatsAppWindow | null)?.CardNestNative;
      if (!bridge) return { result: 'BLOCKED', packages: [] };
      const packages = this.availablePackages(bridge);
      if (packages.length === 1) {
        bridge.openWhatsAppIn(digits, message.trim().slice(0, 500), packages[0]);
        return { result: 'OPENED', packages };
      }
      if (packages.length > 1) return { result: 'CHOOSER', packages };
      return { result: 'BROWSER_FALLBACK', packages };
    }
    return { result: this.openWeb(digits, message) ? 'OPENED' : 'BLOCKED', packages: [] };
  }

  choose(number: string, message: string, packageName: WhatsAppPackage): boolean {
    const normalized = normalizeIndianMobileNumber(number);
    if (!normalized || !KNOWN_PACKAGES.includes(packageName)) return false;
    const bridge = (this.document.defaultView as WhatsAppWindow | null)?.CardNestNative;
    if (!bridge || Capacitor.getPlatform() !== 'android') return false;
    bridge.openWhatsAppIn(normalized.replace(/\D/g, ''), message.trim().slice(0, 500), packageName);
    return true;
  }

  openFallback(number: string, message = ''): boolean {
    const normalized = normalizeIndianMobileNumber(number);
    if (!normalized) return false;
    const digits = normalized.replace(/\D/g, '');
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      const bridge = (this.document.defaultView as WhatsAppWindow | null)?.CardNestNative;
      if (!bridge) return false;
      bridge.openWhatsAppFallback(digits, message.trim().slice(0, 500));
      return true;
    }
    return this.openWeb(digits, message);
  }

  private availablePackages(bridge: WhatsAppBridge): readonly WhatsAppPackage[] {
    try {
      const value: unknown = JSON.parse(bridge.availableWhatsAppApps());
      if (!Array.isArray(value)) return [];
      return value.filter(
        (item): item is WhatsAppPackage => item === 'com.whatsapp' || item === 'com.whatsapp.w4b',
      );
    } catch {
      return [];
    }
  }

  private openWeb(digits: string, message: string): boolean {
    const url = `https://wa.me/${digits}${message.trim() ? `?text=${encodeURIComponent(message.trim().slice(0, 500))}` : ''}`;
    const browser = this.document.defaultView;
    if (!browser) return false;
    browser.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
}
