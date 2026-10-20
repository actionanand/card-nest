import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { PlatformTools } from './platform-tools.android';

describe('Deliberate Android SMS Review navigation', () => {
  afterEach(() => vi.restoreAllMocks());
  it('uses the shared message icon and transient navigation info without opening permissions itself', () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    TestBed.configureTestingModule({ imports: [PlatformTools], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(PlatformTools);
    fixture.detectChanges();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const link = fixture.nativeElement.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent?.trim()).toBe('SMS Review');
    expect(link.querySelector('app-icon')?.getAttribute('name')).toBe('message');
    expect(navigate).not.toHaveBeenCalled();
    link.click();
    expect(navigate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ info: { smsReviewEntry: true } }),
    );
    expect(navigate.mock.calls[0][1]?.state).toBeUndefined();
  });
  it('does not render Android navigation on web', () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
    TestBed.configureTestingModule({ imports: [PlatformTools], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(PlatformTools);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('a')).toBeNull();
  });
});
