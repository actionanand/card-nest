import { Directive, input, output, signal } from '@angular/core';

/** Optional affordances only: a right swipe opens review, never approves money. */
@Directive({
  selector: '[appSmsSwipe]',
  host: {
    '[style.touch-action]': "enabled() ? 'pan-y' : null",
    '[attr.data-swipe]': 'hint()',
    '(pointerdown)': 'start($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'finish($event)',
    '(pointercancel)': 'cancel()',
    '(lostpointercapture)': 'cancel()',
  },
})
export class SmsSwipe {
  readonly enabled = input(false);
  readonly reviewSwipe = output<void>();
  readonly readSwipe = output<void>();
  readonly hint = signal('');
  private origin: { x: number; y: number; id: number } | null = null;
  start(event: PointerEvent): void {
    this.cancel();
    if (
      !this.enabled() ||
      !event.isPrimary ||
      event.button !== 0 ||
      event.clientX < 24 ||
      event.clientX > innerWidth - 24 ||
      (event.target as HTMLElement).closest('button,input,a,select,textarea')
    )
      return;
    this.origin = { x: event.clientX, y: event.clientY, id: event.pointerId };
  }
  move(event: PointerEvent): void {
    if (!this.origin || event.pointerId !== this.origin.id) return;
    const dx = event.clientX - this.origin.x;
    const dy = Math.abs(event.clientY - this.origin.y);
    if (dy > 12 && dy * 1.8 > Math.abs(dx)) {
      this.cancel();
      return;
    }
    if (Math.abs(dx) > 24 && Math.abs(dx) > dy * 1.8) this.hint.set(dx > 0 ? 'review' : 'read');
  }
  finish(event: PointerEvent): void {
    const origin = this.origin;
    this.cancel();
    if (!this.enabled() || !origin || origin.id !== event.pointerId) return;
    const dx = event.clientX - origin.x;
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(event.clientY - origin.y) * 1.8) return;
    if (dx > 0) this.reviewSwipe.emit();
    else this.readSwipe.emit();
  }
  cancel(): void {
    this.origin = null;
    this.hint.set('');
  }
}
