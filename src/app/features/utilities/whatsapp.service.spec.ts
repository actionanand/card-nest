import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { WhatsAppService } from './whatsapp.service';

describe('Indian WhatsApp launcher', () => {
  let service: WhatsAppService;
  let installed: string[];
  const bridge = {
    availableWhatsAppApps: vi.fn(() => JSON.stringify(installed)),
    openWhatsAppIn: vi.fn(),
    openWhatsAppFallback: vi.fn(),
  };

  beforeEach(() => {
    installed = [];
    bridge.availableWhatsAppApps.mockClear();
    bridge.availableWhatsAppApps.mockImplementation(() => JSON.stringify(installed));
    bridge.openWhatsAppIn.mockClear();
    bridge.openWhatsAppFallback.mockClear();
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    Object.assign(window, { CardNestNative: bridge });
    TestBed.configureTestingModule({ providers: [WhatsAppService] });
    service = TestBed.inject(WhatsAppService);
  });

  afterEach(() => {
    delete (window as Window & { CardNestNative?: unknown }).CardNestNative;
    vi.restoreAllMocks();
  });

  it('opens the only installed app directly and offers the chooser when both exist', () => {
    installed = ['com.whatsapp'];
    expect(service.open('9876543210').result).toBe('OPENED');
    expect(bridge.openWhatsAppIn).toHaveBeenCalledWith('919876543210', '', 'com.whatsapp');

    installed = ['com.whatsapp', 'com.whatsapp.w4b', 'com.unrelated.app'];
    expect(service.open('+91-9876543210').packages).toEqual(['com.whatsapp', 'com.whatsapp.w4b']);
    expect(service.open('9876543210').result).toBe('CHOOSER');
  });

  it('offers an explicit browser fallback when neither app is installed', () => {
    expect(service.open('9876543210').result).toBe('BROWSER_FALLBACK');
    expect(bridge.openWhatsAppFallback).not.toHaveBeenCalled();
    expect(service.openFallback('9876543210', 'Hello from CardNest')).toBe(true);
    expect(bridge.openWhatsAppFallback).toHaveBeenCalledWith('919876543210', 'Hello from CardNest');
  });

  it('rejects malformed numbers before opening any app', () => {
    expect(service.open('12345').result).toBe('INVALID');
    expect(bridge.openWhatsAppIn).not.toHaveBeenCalled();
    expect(bridge.openWhatsAppFallback).not.toHaveBeenCalled();
  });

  it('normalizes valid international and toll-free destinations only when launching', () => {
    installed = ['com.whatsapp'];
    expect(service.open('+1 (800) 555-0199').result).toBe('OPENED');
    expect(bridge.openWhatsAppIn).toHaveBeenLastCalledWith('18005550199', '', 'com.whatsapp');
    expect(service.open('1800-123-4567').result).toBe('OPENED');
    expect(bridge.openWhatsAppIn).toHaveBeenLastCalledWith('18001234567', '', 'com.whatsapp');
    expect(service.open('Call 1800-123-4567').result).toBe('INVALID');
  });

  it('opens a validated wa.me URL in the Web build without package detection', () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    expect(service.open('+91 98765 43210', 'Hello India').result).toBe('OPENED');
    expect(open).toHaveBeenCalledWith(
      'https://wa.me/919876543210?text=Hello%20India',
      '_blank',
      'noopener,noreferrer',
    );
    expect(bridge.availableWhatsAppApps).not.toHaveBeenCalled();
  });
});
