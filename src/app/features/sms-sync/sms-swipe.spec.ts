import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { SmsSwipe } from './sms-swipe';

@Component({
  imports: [SmsSwipe],
  template:
    '<article appSmsSwipe [enabled]="enabled()" (reviewSwipe)="reviews.set(reviews()+1)" (readSwipe)="dismissals.set(dismissals()+1)"><div class="candidate-content"><span>Evidence</span><button (click)="clicks.set(clicks()+1)">Review</button></div></article>',
})
class SwipeHost {
  readonly enabled = signal(false);
  readonly reviews = signal(0);
  readonly dismissals = signal(0);
  readonly clicks = signal(0);
}
describe('Dispatched SMS pointer gestures using the Reminder slide interaction', () => {
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
    const pointer = (type: string, x: number, y = 100, element: HTMLElement = target, id = 1) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(
        event,
        Object.fromEntries(
          Object.entries({
            clientX: x,
            clientY: y,
            pointerId: id,
            isPrimary: true,
            button: 0,
            pointerType: 'touch',
          }).map(([k, v]) => [k, { value: v }]),
        ),
      );
      element.dispatchEvent(event);
      fixture.detectChanges();
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
  it('defaults off, captures/slides when enabled, and emits review or dismissal only once', () => {
    const { fixture, article, pointer, host, swipe } = setup();
    pointer('pointerdown', 100);
    pointer('pointermove', 190);
    pointer('pointerup', 190);
    expect(host.reviews()).toBe(0);
    expect(article.setPointerCapture).not.toHaveBeenCalled();
    host.enabled.set(true);
    fixture.detectChanges();
    pointer('pointerdown', 100);
    pointer('pointermove', 190);
    expect(article.setPointerCapture).toHaveBeenCalledWith(1);
    expect(swipe.offset()).toBe(81);
    expect(article.style.getPropertyValue('--sms-drag')).toBe('81px');
    pointer('pointerup', 190);
    pointer('pointerup', 190);
    expect(host.reviews()).toBe(1);
    expect(swipe.offset()).toBe(0);
    expect(article.releasePointerCapture).toHaveBeenCalledWith(1);
    pointer('pointerdown', 190);
    pointer('pointermove', 100);
    pointer('pointerup', 100);
    expect(host.dismissals()).toBe(1);
    // No approval API is injected or called by this directive.
  });
  it('leaves vertical scroll, short drags, Back edges and nested buttons available', () => {
    const { fixture, article, pointer, host } = setup();
    host.enabled.set(true);
    fixture.detectChanges();
    for (const [x, endX, endY] of [
      [10, 150, 100],
      [100, 180, 230],
      [100, 120, 100],
    ]) {
      pointer('pointerdown', x);
      pointer('pointermove', endX, endY);
      pointer('pointerup', endX, endY);
    }
    const button = article.querySelector('button')!;
    pointer('pointerdown', 100, 100, button);
    pointer('pointermove', 190, 100, button);
    pointer('pointerup', 190, 100, button);
    button.click();
    expect(host.clicks()).toBe(1);
    expect(host.reviews()).toBe(0);
    expect(host.dismissals()).toBe(0);
  });
  it('cancels on pointer loss, Back, background, scrolling and preference changes', () => {
    const { fixture, article, pointer, host, swipe } = setup();
    host.enabled.set(true);
    fixture.detectChanges();
    for (const type of [
      'pointercancel',
      'lostpointercapture',
      'cardnest:back',
      'blur',
      'visibilitychange',
      'scroll',
    ]) {
      pointer('pointerdown', 100);
      pointer('pointermove', 190);
      if (type === 'pointercancel' || type === 'lostpointercapture')
        article.dispatchEvent(new Event(type));
      else if (type === 'visibilitychange' || type === 'scroll')
        document.dispatchEvent(new Event(type));
      else window.dispatchEvent(new Event(type));
      pointer('pointerup', 190);
      expect(swipe.offset()).toBe(0);
    }
    pointer('pointerdown', 100);
    pointer('pointermove', 190);
    host.enabled.set(false);
    fixture.detectChanges();
    pointer('pointerup', 190);
    expect(host.reviews()).toBe(0);
    expect(host.dismissals()).toBe(0);
  });
});
