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

const EDGE_GUARD = 24;
const INTENT_DISTANCE = 10;
const HORIZONTAL_DOMINANCE = 1.35;
const ACTION_THRESHOLD = 48;
const MAX_OFFSET = 120;

interface ActiveSwipe {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  horizontal: boolean;
  captured: boolean;
}

/** Android-safe card gesture that requests review or dismissal, never financial approval. */
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
    '(pointercancel)': 'cancel($event)',
    '(lostpointercapture)': 'captureLost($event)',
    '(window:cardnest:back)': 'cancel()',
    '(window:blur)': 'cancel()',
    '(window:pagehide)': 'cancel()',
    '(document:visibilitychange)': 'cancel()',
  },
})
export class SmsSwipe {
  readonly enabled = input(false);
  readonly dismissEnabled = input(true);
  readonly reviewSwipe = output<void>();
  readonly readSwipe = output<void>();
  readonly hint = signal('');
  readonly offset = signal(0);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private active: ActiveSwipe | null = null;
  private suppressClick = false;
  private suppressClickTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly preventDraggedClick = (event: MouseEvent): void => {
    if (!this.suppressClick || event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.clearClickSuppression();
  };

  constructor() {
    effect(() => {
      if (!this.enabled()) this.cancel();
    });
    // Capture before a nested action button handles the synthetic post-drag click.
    this.element.nativeElement.addEventListener('click', this.preventDraggedClick, true);
    inject(DestroyRef).onDestroy(() => {
      this.cancel();
      this.clearClickSuppression();
      this.element.nativeElement.removeEventListener('click', this.preventDraggedClick, true);
    });
  }

  start(event: PointerEvent): void {
    this.cancel();
    this.clearClickSuppression();
    if (
      !this.enabled() ||
      event.isPrimary === false ||
      (event.pointerType === 'mouse' && event.button !== 0) ||
      event.clientX < EDGE_GUARD ||
      event.clientX > innerWidth - EDGE_GUARD ||
      (event.target as Element).closest('button,input,a,select,textarea,summary,[role="button"]')
    )
      return;

    const active: ActiveSwipe = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      horizontal: false,
      captured: false,
    };
    this.active = active;
    try {
      this.element.nativeElement.setPointerCapture?.(event.pointerId);
      active.captured = this.element.nativeElement.hasPointerCapture?.(event.pointerId) ?? false;
    } catch {
      // Some Android WebViews can refuse capture while handing a touch to scrolling.
      active.captured = false;
    }
  }

  move(event: PointerEvent): void {
    const active = this.active;
    if (!active || event.pointerId !== active.id) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    const horizontalDistance = Math.abs(dx);
    const verticalDistance = Math.abs(dy);

    if (!active.horizontal) {
      if (horizontalDistance < INTENT_DISTANCE && verticalDistance < INTENT_DISTANCE) return;
      if (verticalDistance >= horizontalDistance || horizontalDistance < verticalDistance * HORIZONTAL_DOMINANCE) {
        this.cancel(event);
        return;
      }
      active.horizontal = true;
      if (dx < 0 && !this.dismissEnabled()) {
        this.cancel(event);
        return;
      }
      this.armClickSuppression();
    }

    if (event.cancelable) event.preventDefault();
    const offset = Math.sign(dx) * Math.min(MAX_OFFSET, horizontalDistance * 0.9);
    this.offset.set(offset);
    this.hint.set(
      offset >= ACTION_THRESHOLD
        ? 'review-ready'
        : offset <= -ACTION_THRESHOLD
          ? 'read-ready'
          : offset > 0
            ? 'review'
            : 'read',
    );
  }

  finish(event: PointerEvent): void {
    if (!this.active || event.pointerId !== this.active.id) return;
    // A fast touch can arrive with no final pointermove in Android WebView.
    this.move(event);
    const active = this.active;
    if (!active) return;
    const offset = this.offset();
    const action =
      active.horizontal && Math.abs(offset) >= ACTION_THRESHOLD
        ? offset > 0
          ? 'review'
          : 'read'
        : null;
    this.reset(active.id);
    if (action === 'review') this.reviewSwipe.emit();
    if (action === 'read') this.readSwipe.emit();
  }

  captureLost(event: PointerEvent): void {
    if (!this.active || event.pointerId !== this.active.id) return;
    this.reset(event.pointerId, false);
  }

  cancel(event?: PointerEvent): void {
    if (event && (!this.active || event.pointerId !== this.active.id)) return;
    this.reset(this.active?.id);
  }

  private reset(pointerId: number | undefined, release = true): void {
    const active = this.active;
    this.active = null;
    this.offset.set(0);
    this.hint.set('');
    if (
      release &&
      active?.captured &&
      pointerId !== undefined &&
      this.element.nativeElement.hasPointerCapture?.(pointerId)
    )
      this.element.nativeElement.releasePointerCapture(pointerId);
  }

  private armClickSuppression(): void {
    this.suppressClick = true;
    if (this.suppressClickTimer !== null) clearTimeout(this.suppressClickTimer);
    this.suppressClickTimer = setTimeout(() => this.clearClickSuppression(), 350);
  }

  private clearClickSuppression(): void {
    this.suppressClick = false;
    if (this.suppressClickTimer !== null) clearTimeout(this.suppressClickTimer);
    this.suppressClickTimer = null;
  }
}
