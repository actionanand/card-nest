import { Component, input, output } from '@angular/core';

export interface PurchaseReviewMatch {
  id: string;
  label: string;
  source: string;
  reason: string;
  timeDifference: string;
  canMatch?: boolean;
}

@Component({
  selector: 'app-sms-purchase-comparison',
  template: `
    <section aria-label="Possible matching purchase">
      <h3>Possible matching purchase</h3>
      <p>A similar transaction was found. Confirm whether this SMS represents the same purchase.</p>
      <p>{{ timing() }}</p>
      <ul aria-label="Earlier transactions">
        @for (entry of matches(); track entry.id) {
          <li [class.selected]="selected() === entry.id">
            <strong>Earlier transaction</strong>
            <p>{{ entry.label }}</p>
            <p>{{ entry.source }}</p>
            <p>{{ entry.reason }}</p>
            @if (entry.timeDifference) {
              <p>{{ entry.timeDifference }}</p>
            }
            <button
              type="button"
              class="btn"
              [attr.aria-pressed]="selected() === entry.id"
              [disabled]="entry.canMatch === false"
              [attr.aria-label]="'Match earlier entry: ' + entry.label + ' · ' + entry.source"
              (click)="match.emit(entry.id)"
            >
              Match earlier entry
            </button>
          </li>
        }
      </ul>
      <button
        type="button"
        class="btn"
        [attr.aria-pressed]="separate()"
        (click)="confirmSeparate.emit()"
      >
        Confirm separate purchase
      </button>
      <p role="status">
        @if (selected()) {
          Selected earlier entry. Final approval links this SMS without another purchase.
        } @else if (separate()) {
          Confirmed separate purchase. Final approval creates one new entry.
        } @else {
          Choose a match or confirm a separate purchase before approval.
        }
      </p>
      <small>You can change this choice. Nothing financial changes until final approval.</small>
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    section {
      padding: 0.8rem;
      border: 1px solid var(--line);
      border-radius: 0.7rem;
      background: var(--surface);
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    h3 {
      font-size: 1rem;
      margin: 0 0 0.4rem;
    }
    p,
    small {
      font-size: 0.85rem;
      line-height: 1.5;
      margin: 0.35rem 0;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0.6rem 0;
      display: grid;
      gap: 0.6rem;
    }
    li {
      padding: 0.65rem;
      border: 1px solid var(--line);
      border-radius: 0.5rem;
      min-width: 0;
    }
    li.selected {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .btn {
      min-height: 44px;
      width: 100%;
      white-space: normal;
      text-align: center;
    }
    button[aria-pressed='true'] {
      border: 2px solid var(--accent);
    }
    button:focus-visible {
      outline: 3px solid var(--accent);
      outline-offset: 3px;
    }
  `,
})
export class SmsPurchaseComparison {
  readonly matches = input.required<readonly PurchaseReviewMatch[]>();
  readonly selected = input('');
  readonly separate = input(false);
  readonly timing = input('');
  readonly match = output<string>();
  readonly confirmSeparate = output<void>();
}
