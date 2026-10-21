import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { SmsSwipe } from './sms-swipe';

@Component({
  imports: [SmsSwipe],
  template:
    '<article appSmsSwipe [enabled]="enabled()" [dismissEnabled]="dismissEnabled()" (reviewSwipe)="reviews.set(reviews()+1)" (readSwipe)="dismissals.set(dismissals()+1)"><div class="candidate-content"><span>Evidence</span><button (click)="clicks.set(clicks()+1)">Review</button></div></article>',
})
class SwipeHost {
  readonly enabled = signal(false);
  readonly dismissEnabled = signal(true);
  readonly reviews = signal(0);
  readonly dismissals = signal(0);
  readonly clicks = signal(0);
}

interface PointerOptions {
  readonly id?: number;
  readonly isPrimary?: boolean;
  readonly button?: number;
  readonly pointerType?: string;
}

describe('Android-safe SMS Review swipe gestures', () => {
  function setup() {
    const fixture = TestBed.createComponent(SwipeHost);
    fixture.detectChanges();
    const article: HTMLElement = fixture.nativeElement.querySelector('article');
    const target: HTMLElement = article.querySelector('span')!;
    const capture = new Set<number>();
    article.setPointerCapture = vi.fn((id: number) => {
      capture.add(id);
    });
    article.hasPointerCapture = (id: number) => capture.has(id);
    article.releasePointerCapture = vi.fn((id: number) => {
      capture.delete(id);
    });
    const pointer = (
      type: string,
      x: number,
      y = 100,
      element: HTMLElement = target,
      options: PointerOptions = {},
    ) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(
        event,
        Object.fromEntries(
          Object.entries({
            clientX: x,
            clientY: y,
            pointerId: options.id ?? 1,
            isPrimary: options.isPrimary ?? true,
            button: options.button ?? 0,
            pointerType: options.pointerType ?? 'touch',
          }).map(([key, value]) => [key, { value }]),
        ),
      );
      element.dispatchEvent(event);
      fixture.detectChanges();
      return event;
    };
    return {
      fixture,
      article,
      target,
      pointer,
      host: fixture.componentInstance,
      swipe: fixture.debugElement.query(By.directive(SmsSwipe)).injector.get(SmsSwipe),
    };
  }

  it('captures the accepted pointer at touch start and emits each completed direction once', () => {
    const { fixture, article, pointer, host, swipe } = setup();
    pointer('pointerdown', 100);
    expect(article.setPointerCapture).not.toHaveBeenCalled();

    host.enabled.set(true);
    fixture.detectChanges();
    pointer('pointerdown', 100);
    expect(article.setPointerCapture).toHaveBeenCalledWith(1);
    pointer('pointermove', 190);
    expect(swipe.offset()).toBe(81);
    expect(article.dataset['swipe']).toBe('review-ready');
    pointer('pointerup', 190);
    pointer('pointerup', 190);
    expect(host.reviews()).toBe(1);
    expect(swipe.offset()).toBe(0);
    expect(article.releasePointerCapture).toHaveBeenCalledWith(1);

    pointer('pointerdown', 190);
    pointer('pointermove', 100);
    pointer('pointerup', 100);
    expect(host.dismissals()).toBe(1);
  });

  it('handles fast and slow swipes while returning short drags to rest', () => {
    const { fixture, pointer, host, swipe } = setup();
    host.enabled.set(true);
    fixture.detectChanges();

    pointer('pointerdown', 100);
    pointer('pointermove', 151);
    pointer('pointerup', 151);
    expect(host.reviews()).toBe(0);
    expect(swipe.offset()).toBe(0);

    // Android can deliver a final position in pointerup without another pointermove.
    pointer('pointerdown', 100);
    pointer('pointerup', 160);
    expect(host.reviews()).toBe(1);

    pointer('pointerdown', 180);
    pointer('pointermove', 150);
    pointer('pointermove', 120);
    pointer('pointermove', 90);
    pointer('pointerup', 90);
    expect(host.dismissals()).toBe(1);
  });

  it('preserves vertical scroll, ambiguous diagonals, system edges and nested buttons', () => {
    const { fixture, article, pointer, host, swipe } = setup();
    host.enabled.set(true);
    fixture.detectChanges();

    pointer('pointerdown', 100);
    pointer('pointermove', 110, 180);
    pointer('pointerup', 110, 180);
    expect(swipe.offset()).toBe(0);

    pointer('pointerdown', 100);
    pointer('pointermove', 150, 142);
    pointer('pointerup', 150, 142);
    pointer('pointerdown', 10);
    pointer('pointermove', 150);
    pointer('pointerup', 150);

    const button = article.querySelector('button')!;
    pointer('pointerdown', 100, 100, button);
    pointer('pointermove', 190, 100, button);
    pointer('pointerup', 190, 100, button);
    button.click();
    expect(host.clicks()).toBe(1);
    expect(host.reviews()).toBe(0);
    expect(host.dismissals()).toBe(0);
  });

  it('does not let scroll, cancellation or capture loss create an action', () => {
    const { fixture, article, pointer, host, swipe } = setup();
    host.enabled.set(true);
    fixture.detectChanges();

    pointer('pointerdown', 100);
    pointer('pointermove', 190);
    document.dispatchEvent(new Event('scroll'));
    pointer('pointerup', 190);
    expect(host.reviews()).toBe(1);

    pointer('pointerdown', 100);
    pointer('pointermove', 190);
    pointer('pointercancel', 190, 100, article);
    pointer('pointerup', 190);

    pointer('pointerdown', 100);
    pointer('pointermove', 190);
    pointer('lostpointercapture', 190, 100, article);
    pointer('pointerup', 190);

    pointer('pointerdown', 100);
    pointer('pointermove', 190);
    window.dispatchEvent(new Event('cardnest:back'));
    pointer('pointerup', 190);

    pointer('pointerdown', 100);
    pointer('pointermove', 190);
    document.dispatchEvent(new Event('visibilitychange'));
    pointer('pointerup', 190);
    expect(host.reviews()).toBe(1);
    expect(swipe.offset()).toBe(0);
  });

  it('suppresses the post-drag synthetic click without blocking a normal button click', () => {
    const { fixture, article, pointer, host } = setup();
    host.enabled.set(true);
    fixture.detectChanges();
    const button = article.querySelector('button')!;

    pointer('pointerdown', 100);
    pointer('pointermove', 190);
    pointer('pointerup', 190);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(host.clicks()).toBe(0);

    button.click();
    expect(host.clicks()).toBe(1);
  });

  it('keeps one primary pointer, cancels when disabled, and survives release cleanup races', () => {
    const { fixture, article, pointer, host } = setup();
    host.enabled.set(true);
    fixture.detectChanges();

    pointer('pointerdown', 100, 100, undefined, { isPrimary: false, id: 2 });
    pointer('pointermove', 190, 100, undefined, { id: 2 });
    pointer('pointerup', 190, 100, undefined, { id: 2 });
    expect(host.reviews()).toBe(0);

    host.dismissEnabled.set(false);
    fixture.detectChanges();
    pointer('pointerdown', 190);
    pointer('pointermove', 100);
    pointer('pointerup', 100);
    expect(host.dismissals()).toBe(0);
    host.dismissEnabled.set(true);
    fixture.detectChanges();

    pointer('pointerdown', 100);
    pointer('pointermove', 190, 100, undefined, { id: 2 });
    pointer('pointerup', 190, 100, undefined, { id: 2 });
    host.enabled.set(false);
    fixture.detectChanges();
    pointer('pointerup', 190);
    expect(host.reviews()).toBe(0);

    host.enabled.set(true);
    fixture.detectChanges();
    article.releasePointerCapture = vi.fn((id: number) => {
      const event = new Event('lostpointercapture', { bubbles: true });
      Object.defineProperty(event, 'pointerId', { value: id });
      article.dispatchEvent(event);
    });
    pointer('pointerdown', 100);
    pointer('pointermove', 190);
    pointer('pointerup', 190);
    expect(host.reviews()).toBe(1);
  });
});
