import {
  Component,
  input,
  output,
  inject,
  ElementRef,
  DestroyRef,
  afterNextRender,
} from '@angular/core';
import { AppIcon } from './app-icon';

@Component({
  selector: 'app-confirmation-dialog',
  imports: [AppIcon],
  template: `
    <div
      class="confirmation-backdrop"
      tabindex="-1"
      (click)="cancel()"
      (keydown.escape)="$event.stopPropagation(); cancel()"
    >
      <section
        class="panel confirmation-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        aria-describedby="confirmation-message"
        tabindex="-1"
        (click)="$event.stopPropagation()"
        (keydown)="handleKey($event)"
      >
        <span class="confirmation-icon" aria-hidden="true"><app-icon name="warning" /></span>
        <div>
          <h2 id="confirmation-title">{{ title() }}</h2>
          <p id="confirmation-message">{{ message() }}</p>
          @if (error()) {
            <p role="alert">{{ error() }}</p>
          }
        </div>
        <div class="confirmation-actions">
          <button class="btn" type="button" [disabled]="busy()" (click)="cancel()">Cancel</button>
          <button class="btn danger-confirm" type="button" [disabled]="busy()" (click)="confirm()">
            {{ confirmLabel() }}
          </button>
        </div>
      </section>
    </div>
  `,
  styles: `
    .confirmation-backdrop {
      position: fixed;
      z-index: 1100;
      inset: 0;
      display: grid;
      place-items: center;
      padding: calc(env(safe-area-inset-top) + 4.5rem) max(1rem, env(safe-area-inset-right))
        max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
      background: rgb(10 25 18 / 68%);
      backdrop-filter: blur(4px);
    }
    .confirmation-dialog {
      display: grid;
      width: min(100%, 27rem);
      grid-template-columns: auto minmax(0, 1fr);
      gap: 0.8rem;
      padding: 1.2rem;
    }
    .confirmation-icon {
      display: grid;
      width: 2.8rem;
      height: 2.8rem;
      place-items: center;
      border-radius: 50%;
      color: var(--danger);
      background: var(--danger-soft);
    }
    .confirmation-icon app-icon {
      width: 1.3rem;
      height: 1.3rem;
    }
    h2 {
      margin: 0;
      font-size: 1.15rem;
    }
    p {
      margin: 0.35rem 0 0;
      color: var(--muted);
      line-height: 1.5;
    }
    .confirmation-actions {
      display: flex;
      grid-column: 1 / -1;
      justify-content: flex-end;
      gap: 0.55rem;
      margin-top: 0.4rem;
    }
    .danger-confirm {
      border-color: var(--danger);
      color: var(--confirmation-danger-ink, white);
      background: var(--danger);
    }
    @media (max-width: 480px) {
      .confirmation-backdrop {
        align-items: end;
        padding: 0;
      }
      .confirmation-dialog {
        width: 100%;
        padding: 1.2rem max(1rem, env(safe-area-inset-right))
          max(1.2rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
        border-radius: 1.2rem 1.2rem 0 0;
      }
      .confirmation-actions .btn {
        flex: 1;
      }
    }
  `,
})
export class ConfirmationDialog {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  constructor() {
    const back = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.cancel();
    };
    window.addEventListener('cardnest:back', back, { capture: true });
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    afterNextRender(() =>
      this.element.nativeElement.querySelector<HTMLButtonElement>('button')?.focus(),
    );
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('cardnest:back', back, { capture: true });
      if (previous?.isConnected) previous.focus();
    });
  }
  handleKey(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
    }
    if (event.key !== 'Tab') return;
    const buttons = [
      ...this.element.nativeElement.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
    ];
    if (!buttons.length) {
      event.preventDefault();
      this.element.nativeElement.querySelector<HTMLElement>('[role="alertdialog"]')?.focus();
      return;
    }
    const first = buttons[0],
      last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  readonly title = input.required<string>();
  readonly message = input.required<string>();
  readonly confirmLabel = input('Delete');
  readonly busy = input(false);
  readonly error = input<string | null>(null);
  cancel(): void {
    if (!this.busy()) this.cancelled.emit();
  }
  confirm(): void {
    if (!this.busy()) this.confirmed.emit();
  }
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();
}
