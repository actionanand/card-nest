import {
  Directive,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

/** Reminder card-slide interaction. Outputs request review/dismissal, never financial approval. */
@Directive({
  selector: '[appSmsSwipe]',
  host: {
    '[style.touch-action]': "enabled() ? 'pan-y' : null",
    '[style.--sms-drag]': "offset() + 'px'",
    '[attr.data-swipe]': 'hint()',
    '[class.dragging]': 'offset() !== 0',
    '(pointerdown)': 'start($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'finish($event)',
    '(pointercancel)': 'cancel()',
    '(lostpointercapture)': 'cancel()',
    '(window:cardnest:back)': 'cancel()',
    '(window:blur)': 'cancel()',
    '(window:pagehide)': 'cancel()',
    '(document:visibilitychange)': 'cancel()',
    '(document:scroll)': 'cancel()',
  },
})
export class SmsSwipe {
  readonly enabled = input(false);
  readonly reviewSwipe = output<void>();
  readonly readSwipe = output<void>();
  readonly hint = signal('');
  readonly offset = signal(0);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private origin: { x: number; y: number; id: number } | null = null;
  private horizontal = false;
  private suppressClick = false;
  private readonly preventDraggedClick = (event: MouseEvent): void => {
    if (!this.suppressClick || event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.suppressClick = false;
  };
  constructor() {
    effect(() => {
      if (!this.enabled()) this.cancel();
    });
    // Capture before a nested action button handles the synthetic post-drag click.
    this.element.nativeElement.addEventListener('click', this.preventDraggedClick, true);
    inject(DestroyRef).onDestroy(() => {
      this.cancel();
      this.element.nativeElement.removeEventListener('click', this.preventDraggedClick, true);
    });
  }
  start(event: PointerEvent): void {
    this.cancel();
    this.suppressClick = false;
    if (
      !this.enabled() ||
      event.isPrimary === false ||
      (event.pointerType === 'mouse' && event.button !== 0) ||
      event.clientX < 24 ||
      event.clientX > innerWidth - 24 ||
      (event.target as Element).closest('button,input,a,select,textarea,summary')
    )
      return;
    this.origin = { x: event.clientX, y: event.clientY, id: event.pointerId };
  }
  move(event: PointerEvent): void {
    if (!this.origin || event.pointerId !== this.origin.id) return;
    const dx = event.clientX - this.origin.x;
    const dy = Math.abs(event.clientY - this.origin.y);
    if (!this.horizontal && dy > 8 && dy > Math.abs(dx)) {
      this.cancel();
      return;
    }
    if (!this.horizontal && Math.abs(dx) > 8 && Math.abs(dx) > dy * 1.25) {
      this.horizontal = true;
      this.suppressClick = true;
      this.element.nativeElement.setPointerCapture?.(event.pointerId);
    }
    if (this.horizontal) {
      if (event.cancelable) event.preventDefault();
      // Same resistance and maximum slide as Reminder cards.
      this.offset.set(Math.sign(dx) * Math.min(120, Math.abs(dx) * 0.9));
      this.hint.set(dx > 0 ? 'review' : 'read');
    }
  }
  finish(event: PointerEvent): void {
    if (!this.origin || event.pointerId !== this.origin.id) return;
    this.move(event);
    const offset = this.offset();
    this.cancel();
    if (!this.enabled() || Math.abs(offset) < 55) return;
    if (offset > 0) this.reviewSwipe.emit();
    else this.readSwipe.emit();
  }
  cancel(): void {
    const id = this.origin?.id;
    this.origin = null;
    this.horizontal = false;
    this.offset.set(0);
    this.hint.set('');
    if (id !== undefined && this.element.nativeElement.hasPointerCapture?.(id))
      this.element.nativeElement.releasePointerCapture(id);
  }
}
