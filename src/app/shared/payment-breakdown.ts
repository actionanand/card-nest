import { Component, computed, inject, input, signal } from '@angular/core';
import { CardTransaction } from '../core/models/domain';
import { CardNestStore } from '../core/services/card-nest-store';
import { formatMoney } from '../core/services/money';

@Component({
  selector: 'app-payment-breakdown',
  template: `
    <section aria-label="Payment breakdown">
      <strong>{{ entries().length }} recorded payments · {{ money(total()) }} total</strong>
      <ul>
        @for (entry of entries().slice(0, limit()); track entry.id) {
          <li>
            <span
              >{{ entry.transactionDate }} · {{ entry.merchant || 'Purchase' }}<br />{{
                store.sourceDetail(entry.cardId)
              }}</span
            ><strong>{{ money(entry.amountMinor) }}</strong>
          </li>
        }
      </ul>
      @if (limit() < entries().length) {
        <button type="button" class="btn" (click)="limit.set(limit() + 20)">
          Show more payments
        </button>
      }
      @if (additionalMinor() !== 0) {
        <p>
          Payment change: {{ money(additionalMinor()) }} · Updated total:
          {{ money(total() + additionalMinor()) }}
        </p>
      }
      @if (billTotalMinor() !== null) {
        <p>
          Actual bill: {{ money(billTotalMinor()!) }} ·
          {{
            difference() < 0
              ? money(-difference()) + ' overpaid / unresolved'
              : difference() > 0
                ? money(difference()) + ' remaining / unresolved'
                : 'Payments equal the bill'
          }}
        </p>
      }
      <small
        >Totals summarize real payments. No additional debit or debt is created for a
        difference.</small
      >
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    section {
      border: 1px solid var(--line);
      padding: 0.8rem;
      border-radius: 0.7rem;
      color: var(--ink);
      background: var(--surface);
    }
    ul {
      list-style: none;
      padding: 0;
      display: grid;
      gap: 0.6rem;
    }
    li {
      display: flex;
      justify-content: space-between;
      gap: 0.7rem;
      overflow-wrap: anywhere;
    }
    li span {
      min-width: 0;
    }
    p,
    small {
      line-height: 1.5;
    }
    .btn {
      min-height: 44px;
    }
  `,
})
export class PaymentBreakdown {
  readonly store = inject(CardNestStore);
  readonly entries = input.required<readonly CardTransaction[]>();
  readonly billTotalMinor = input<number | null>(null);
  readonly additionalMinor = input(0);
  readonly limit = signal(20);
  readonly total = computed(() =>
    this.entries().reduce((sum, entry) => sum + entry.amountMinor, 0),
  );
  readonly difference = computed(
    () => (this.billTotalMinor() ?? 0) - this.total() - this.additionalMinor(),
  );
  readonly money = (value: number) => formatMoney(value, 'INR');
}
