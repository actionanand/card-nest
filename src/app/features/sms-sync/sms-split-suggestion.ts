import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney } from '../../core/services/money';
import { AppSelectPicker } from '../../shared/app-select-picker';
import { PaymentBreakdown } from '../../shared/payment-breakdown';
import { SmsEvidence } from './sms-model';
import { SmsSplitProposal } from './sms-split-continuity';

@Component({
  selector: 'app-sms-split-suggestion',
  imports: [AppSelectPicker, PaymentBreakdown],
  template: `
    <section aria-label="Consecutive payment suggestion">
      <h3>These consecutive payments may belong to one purchase.</h3>
      <p>{{ proposal().reason }}</p>
      <p>
        SMS payment awaiting approval: {{ item().merchant || 'Purchase' }} ·
        {{ money(item().amountMinor) }}<br />{{ store.sourceDetail(sourceId()) }} ·
        {{ item().eventDate }}
        {{
          item().eventTimeExplicit
            ? item().eventTime + ' IST (transaction time)'
            : '(SMS receipt timing is approximate)'
        }}
      </p>
      <app-select-picker
        label="Confirm the related purchase or payment group"
        [searchable]="true"
        [options]="targets()"
        [value]="target()"
        (valueChange)="target.set($event)"
      />
      <app-payment-breakdown
        [entries]="members()"
        [additionalMinor]="item().amountMinor"
        [billTotalMinor]="group()?.billTotalMinor ?? null"
      />
      <button
        class="btn"
        type="button"
        [attr.aria-pressed]="!!selectedTarget()"
        [disabled]="!target()"
        (click)="chosen.emit(target())"
      >
        Add to split payment
      </button>
      @if (selectedTarget()) {
        <p role="status">
          Selected as another real payment for this purchase. Final approval records it once and
          attaches it to the group.
        </p>
      }
      <small
        >This is a different payment, not a duplicate match. Selecting it changes no
        balances.</small
      >
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
      display: grid;
      gap: 0.7rem;
      overflow-wrap: anywhere;
    }
    h3,
    p {
      margin: 0;
      line-height: 1.5;
    }
    h3 {
      font-size: 1rem;
    }
    button {
      min-height: 44px;
      white-space: normal;
    }
    button[aria-pressed='true'] {
      border: 2px solid var(--accent);
    }
  `,
})
export class SmsSplitSuggestion {
  readonly store = inject(CardNestStore);
  readonly proposal = input.required<SmsSplitProposal>();
  readonly item = input.required<SmsEvidence>();
  readonly sourceId = input.required<string>();
  readonly selectedTarget = input('');
  readonly chosen = output<string>();
  readonly target = signal('');
  readonly group = computed(() =>
    (this.store.paymentGroups?.() ?? []).find((group) => group.id === this.proposal().targetId),
  );
  readonly members = computed(() =>
    this.store
      .transactions()
      .filter(
        (entry) =>
          this.group()?.memberIds.includes(entry.id) ||
          entry.id === this.proposal().previousTransactionId,
      ),
  );
  readonly targets = computed(() => [
    { value: '', label: 'Choose the purchase or group to confirm' },
    {
      value: this.proposal().targetId,
      label: this.group()?.title || this.members()[0]?.merchant || 'Previous purchase',
      detail: `${this.members().length} recorded payments · ${this.members()
        .map((entry) => this.store.sourceDetail(entry.cardId))
        .join(' · ')}`,
    },
  ]);
  readonly money = (value: number) => formatMoney(value, 'INR');
  constructor() {
    effect(() => {
      this.proposal();
      this.target.set(this.selectedTarget());
    });
  }
}
