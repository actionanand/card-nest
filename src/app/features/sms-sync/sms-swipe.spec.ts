import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { SmsSwipe } from './sms-swipe';

@Component({
  imports: [SmsSwipe],
  template:
    '<article appSmsSwipe [enabled]="enabled()" (reviewSwipe)="reviews.set(reviews()+1)" (readSwipe)="reads.set(reads()+1)"><span>Evidence</span><button>Review</button></article>',
})
class SwipeHost {
  readonly enabled = signal(false);
  readonly reviews = signal(0);
  readonly reads = signal(0);
}
describe('Optional SMS review swipe affordances', () => {
  it('defaults off; right opens review only, left marks read, and never emits an approval', () => {
    const fixture = TestBed.createComponent(SwipeHost);
    fixture.detectChanges();
    const swipe = fixture.debugElement.query(By.directive(SmsSwipe)).injector.get(SmsSwipe);
    const pointer = (
      x: number,
      y = 100,
      id = 1,
      target = fixture.nativeElement.querySelector('span'),
    ) =>
      ({
        clientX: x,
        clientY: y,
        pointerId: id,
        isPrimary: true,
        button: 0,
        target,
      }) as PointerEvent;
    swipe.start(pointer(100));
    swipe.finish(pointer(180));
    expect(fixture.componentInstance.reviews()).toBe(0);
    fixture.componentInstance.enabled.set(true);
    fixture.detectChanges();
    swipe.start(pointer(100));
    swipe.move(pointer(180));
    expect(swipe.hint()).toBe('review');
    swipe.finish(pointer(180));
    swipe.finish(pointer(180));
    expect(fixture.componentInstance.reviews()).toBe(1);
    swipe.start(pointer(180));
    swipe.finish(pointer(100));
    expect(fixture.componentInstance.reads()).toBe(1);
    for (const [startX, endX, endY] of [
      [10, 150, 100],
      [100, 150, 200],
      [100, 130, 100],
    ]) {
      swipe.start(pointer(startX));
      swipe.move(pointer(endX, endY));
      swipe.finish(pointer(endX, endY));
    }
    swipe.start(pointer(100));
    swipe.cancel();
    swipe.finish(pointer(200));
    swipe.start(pointer(100, 100, 1, fixture.nativeElement.querySelector('button')));
    swipe.finish(pointer(200));
    swipe.start(pointer(100));
    swipe.finish(pointer(200, 100, 2));
    expect(fixture.componentInstance.reviews()).toBe(1);
    expect(fixture.componentInstance.reads()).toBe(1);
  });
});
