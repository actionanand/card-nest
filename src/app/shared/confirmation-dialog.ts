import { Component, input, output } from '@angular/core';
import { AppIcon } from './app-icon';

@Component({
  selector: 'app-confirmation-dialog',
  imports: [AppIcon],
  template: `
    <div
      class="confirmation-backdrop"
      tabindex="-1"
      (click)="cancelled.emit()"
      (keydown.escape)="$event.stopPropagation(); cancelled.emit()"
    >
      <section
        class="panel confirmation-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        aria-describedby="confirmation-message"
        tabindex="-1"
        (click)="$event.stopPropagation()"
        (keydown)="$event.stopPropagation()"
      >
        <span class="confirmation-icon" aria-hidden="true"><app-icon name="warning" /></span>
        <div>
          <h2 id="confirmation-title">{{ title() }}</h2>
          <p id="confirmation-message">{{ message() }}</p>
        </div>
        <div class="confirmation-actions">
          <button class="btn" type="button" (click)="cancelled.emit()">Cancel</button>
          <button class="btn danger-confirm" type="button" (click)="confirmed.emit()">
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
      color: white;
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
  readonly title = input.required<string>();
  readonly message = input.required<string>();
  readonly confirmLabel = input('Delete');
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();
}
