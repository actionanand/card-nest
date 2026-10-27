import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
  untracked,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { CardNestStore } from '../../core/services/card-nest-store';
import { eligiblePaymentMember } from '../../core/services/payment-groups';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { AppSelectPicker } from '../../shared/app-select-picker';
import { PaymentBreakdown } from '../../shared/payment-breakdown';

@Component({
  selector: 'app-payment-groups-panel',
  imports: [ReactiveFormsModule, AppSelectPicker, PaymentBreakdown],
  template: `
    <section class="panel" aria-label="Combine payments">
      <h2 #heading tabindex="-1">Combine payments</h2>
      <p>
        Associate real payments with one purchase. Amounts, sources, references and balances are
        preserved.
      </p>
      <app-select-picker
        label="Related purchase or payment group"
        [searchable]="true"
        [options]="targets()"
        [value]="target()"
        (valueChange)="chooseTarget($event)"
      />
      <label>Group title / merchant<input [formControl]="title" maxlength="150" /></label>
      <label>Actual bill total (optional)<input [formControl]="bill" inputmode="decimal" /></label>
      <app-payment-breakdown [entries]="preview()" [billTotalMinor]="billValue()" />
      @if (group(); as current) {
        <details>
          <summary>Manage {{ current.memberIds.length }} group members</summary>
          @for (entry of preview().slice(0, memberLimit()); track entry.id) {
            @if (current.memberIds.includes(entry.id)) {
              <p>
                {{ entry.merchant || entry.transactionDate }} ·
                {{ store.sourceName(entry.cardId) }} · {{ money(entry.amountMinor) }}
                <button class="btn" type="button" [disabled]="busy()" (click)="remove(entry.id)">
                  Remove from group
                </button>
              </p>
            }
          }
          @if (memberLimit() < current.memberIds.length) {
            <button class="btn" type="button" (click)="memberLimit.set(memberLimit() + 20)">
              Show more members
            </button>
          }
          <button class="btn" type="button" [disabled]="busy()" (click)="dissolve()">
            Dissolve group — keep every payment
          </button>
        </details>
      }
      <label
        >Find recorded payments<input
          type="search"
          [formControl]="search"
          placeholder="Merchant, date, amount, source or group title"
      /></label>
      <fieldset>
        <legend>Select additional recorded payments</legend>
        @for (entry of available().slice(0, limit()); track entry.id) {
          <label class="member"
            ><input
              type="checkbox"
              [checked]="selected().has(entry.id)"
              (change)="toggle(entry.id)"
            />
            <span
              >{{ entry.merchant || 'Purchase' }} · {{ entry.transactionDate }}<br />{{
                store.sourceDetail(entry.cardId)
              }}
              · {{ money(entry.amountMinor) }}</span
            ></label
          >
        }
      </fieldset>
      @if (limit() < available().length) {
        <button class="btn" type="button" (click)="limit.set(limit() + 20)">
          Show more recorded payments
        </button>
      }
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      <div class="actions">
        <button class="btn" type="button" [disabled]="busy()" (click)="closed.emit()">Close</button>
        <button
          class="btn btn-primary"
          type="button"
          [disabled]="busy() || preview().length < 2"
          (click)="save()"
        >
          Save grouping only
        </button>
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .panel {
      display: grid;
      gap: 0.8rem;
      margin-block: 1rem;
      overflow-wrap: anywhere;
    }
    label {
      display: grid;
      gap: 0.3rem;
    }
    .member {
      display: flex;
      align-items: center;
      gap: 0.7rem;
      min-height: 44px;
    }
    .member span {
      min-width: 0;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
    }
    fieldset {
      min-width: 0;
      border: 1px solid var(--line);
    }
    h2:focus {
      outline: 2px solid var(--accent);
    }
    button {
      min-height: 44px;
    }
  `,
})
export class PaymentGroupsPanel {
  readonly store = inject(CardNestStore);
  readonly groupId = input('');
  readonly closed = output<void>();
  readonly target = signal('');
  readonly selected = signal<ReadonlySet<string>>(new Set());
  readonly busy = signal(false);
  readonly error = signal('');
  readonly limit = signal(20);
  readonly memberLimit = signal(20);
  readonly title = new FormControl('', { nonNullable: true });
  readonly bill = new FormControl('', { nonNullable: true });
  readonly search = new FormControl('', { nonNullable: true });
  private readonly term = signal('');
  readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  readonly money = (value: number) => formatMoney(value, 'INR');
  readonly group = computed(() =>
    this.store
      .paymentGroups()
      .find((group) => group.id === this.target() || group.memberIds.includes(this.target())),
  );
  readonly targets = computed(() => [
    { value: '', label: 'Create a group from selected purchases' },
    ...this.store.paymentGroups().map((group) => ({
      value: group.id,
      label: group.title || 'Payment group',
      detail: `${group.memberIds.length} payments · ${group.createdAt.slice(0, 10)} · ${this.store
        .transactions()
        .filter((entry) => group.memberIds.includes(entry.id))
        .map(
          (entry) =>
            `${entry.merchant ?? ''} ${entry.transactionDate} ${entry.amountMinor / 100} ${this.store.sourceDetail(entry.cardId)}`,
        )
        .join(' · ')}`,
    })),
    ...this.store
      .transactions()
      .filter((entry) => entry.type === 'PURCHASE' && !entry.splitGroupId)
      .map((entry) => ({
        value: entry.id,
        label: entry.merchant || 'Purchase',
        detail: `${entry.transactionDate} · ${this.money(entry.amountMinor)} · ${this.store.sourceDetail(entry.cardId)}`,
      })),
  ]);
  readonly available = computed(() =>
    this.store
      .transactions()
      .filter(
        (entry) =>
          eligiblePaymentMember(entry) &&
          !entry.splitGroupId &&
          entry.id !== this.target() &&
          `${entry.merchant} ${entry.transactionDate} ${entry.amountMinor / 100} ${this.store.sourceDetail(entry.cardId)}`
            .toLowerCase()
            .includes(this.term()),
      ),
  );
  readonly preview = computed(() => {
    const ids = new Set([
      ...(this.group()?.memberIds ?? (this.target() ? [this.target()] : [])),
      ...this.selected(),
    ]);
    return this.store.transactions().filter((entry) => ids.has(entry.id));
  });
  // The breakdown reads the current form value on Angular's form event turn.
  billValue(): number | null {
    return this.bill.value.trim() ? parseMoneyToMinor(this.bill.value) : null;
  }
  constructor() {
    effect(() => {
      const id = this.groupId();
      untracked(() => this.chooseTarget(id));
    });
    const subscription = this.search.valueChanges.subscribe((value) => {
      this.term.set(value.toLowerCase().trim());
      this.limit.set(20);
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
    afterNextRender(() => this.heading()?.nativeElement.focus());
  }
  chooseTarget(id: string): void {
    this.target.set(id);
    this.selected.set(new Set());
    const group = this.group();
    this.title.setValue(group?.title ?? '');
    this.bill.setValue(group?.billTotalMinor == null ? '' : String(group.billTotalMinor / 100));
  }
  toggle(id: string): void {
    this.selected.update((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async save(): Promise<void> {
    await this.run(async () => {
      const bill = this.billValue();
      if (this.bill.value.trim() && bill === null) throw new Error('Enter a valid bill total.');
      const ids = [...this.selected()];
      if (this.group() && !ids.length)
        await this.store.updatePaymentGroup(this.group()!.id, {
          title: this.title.value,
          billTotalMinor: bill,
        });
      else {
        const target =
          this.target() || this.preview().find((entry) => entry.type === 'PURCHASE')?.id;
        if (!target) throw new Error('Select an original purchase.');
        await this.store.combinePayments(
          ids.length
            ? [...new Set([target, ...ids])].filter((id) =>
                this.store.transactions().some((row) => row.id === id),
              )
            : this.preview().map((row) => row.id),
          target,
          { title: this.title.value, billTotalMinor: bill },
        );
      }
      this.selected.set(new Set());
      this.closed.emit();
    });
  }
  async remove(id: string): Promise<void> {
    await this.run(async () => {
      await this.store.removePaymentMember(id);
      this.selected.set(new Set());
      if (!this.group()) this.chooseTarget('');
    });
  }
  async dissolve(): Promise<void> {
    const group = this.group();
    if (group)
      await this.run(async () => {
        await this.store.removePaymentMember(group.id, true);
        this.chooseTarget('');
      });
  }
  private async run(work: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await work();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Unable to save grouping.');
    } finally {
      this.busy.set(false);
    }
  }
}
