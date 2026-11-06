import { Component, computed, inject, input, signal } from '@angular/core';
import { CardTransaction } from '../core/models/domain';
import { CardNestStore } from '../core/services/card-nest-store';
import { formatMoney } from '../core/services/money';

@Component({
  selector: 'app-payment-breakdown',
  template: `
    <section aria-label="Payment breakdown">
      <strong>{{ payments().length }} payments · {{ money(total()) }} paid</strong>
      <ul>
        @for (entry of displayEntries().slice(0, limit()); track entry.id) {
          <li>
            <span>{{ entry.date }} · {{ entry.label }}<br />{{ entry.source }}</span>
            <strong>{{ money(entry.amountMinor) }}</strong>
          </li>
        }
      </ul>
      @if (limit() < displayEntries().length) {
        <button type="button" class="btn" (click)="limit.set(limit() + 20)">
          Show more payments
        </button>
      }
      @if (additionalMinor() !== 0) {
        <p>
          Payment change: {{ money(additionalMinor()) }} · Updated paid:
          {{ money(grossPaid() + additionalMinor()) }}
        </p>
      }
      @if (refundsTotal() > 0) {
        <p>Wallet refunds: {{ money(refundsTotal()) }} · Net paid: {{ money(netPaid()) }}</p>
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
  readonly entries = input.required<readonly (CardTransaction | WalletGroupBreakdownEntry)[]>();
  readonly billTotalMinor = input<number | null>(null);
  readonly additionalMinor = input(0);
  readonly limit = signal(20);
  readonly displayEntries = computed(() =>
    this.entries().map((entry) =>
      'kind' in entry
        ? {
            id: entry.id,
            date: entry.eventDate,
            label:
              entry.eventLabel ??
              (entry.kind === 'WALLET_REFUND' ? 'Wallet refund' : 'Wallet purchase'),
            source: entry.walletLabel,
            amountMinor: entry.kind === 'WALLET_REFUND' ? -entry.amountMinor : entry.amountMinor,
          }
        : {
            id: entry.id,
            date: entry.transactionDate,
            label: entry.merchant || 'Purchase',
            source: this.store.sourceDetail(entry.cardId),
            amountMinor: entry.amountMinor,
          },
    ),
  );
  readonly payments = computed(() =>
    this.displayEntries().filter((entry) => entry.amountMinor > 0),
  );
  readonly refundsTotal = computed(
    () =>
      -this.displayEntries()
        .filter((entry) => entry.amountMinor < 0)
        .reduce((sum, entry) => sum + entry.amountMinor, 0),
  );
  readonly grossPaid = computed(() =>
    this.payments().reduce((sum, entry) => sum + entry.amountMinor, 0),
  );
  readonly netPaid = computed(() => this.grossPaid() - this.refundsTotal());
  readonly total = computed(() => this.grossPaid());
  readonly difference = computed(
    () => (this.billTotalMinor() ?? 0) - this.grossPaid() - this.additionalMinor(),
  );
  readonly money = (value: number) => formatMoney(value, 'INR');
}

export interface WalletGroupBreakdownEntry {
  readonly id: string;
  readonly kind: 'WALLET_PURCHASE' | 'WALLET_REFUND';
  readonly eventDate: string;
  readonly amountMinor: number;
  readonly walletLabel: string;
  readonly eventLabel?: string;
}
