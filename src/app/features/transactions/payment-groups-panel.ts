import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { CardNestStore } from '../../core/services/card-nest-store';
import { eligiblePaymentMember } from '../../core/services/payment-groups';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { AppSelectPicker } from '../../shared/app-select-picker';
import { PaymentBreakdown } from '../../shared/payment-breakdown';
import { ProfileModal } from '../../shared/profile-modal';

@Component({
  selector: 'app-payment-groups-panel',
  imports: [ReactiveFormsModule, AppSelectPicker, PaymentBreakdown, ProfileModal],
  template: `
    <app-profile-modal title="Combine Payments" [busy]="busy()" (closed)="closed.emit()">
      <div class="combine-flow">
        @if (!targetEntries().length) {
          <section class="empty-state" aria-labelledby="combine-empty-title">
            <h3 id="combine-empty-title">No recorded purchases are available to combine.</h3>
            <p>Add a real purchase first. Combine Payments never creates a fictional entry.</p>
            <div class="step-actions">
              <button class="btn" type="button" [disabled]="busy()" (click)="closed.emit()">
                Close
              </button>
              <button class="btn btn-primary" type="button" (click)="addTransaction.emit()">
                Add transaction
              </button>
            </div>
          </section>
        } @else {
          <nav class="steps" aria-label="Combine Payments steps">
            @for (label of stepLabels; track label; let index = $index) {
              <span
                [class.current]="step() === index + 1"
                [attr.aria-current]="step() === index + 1 ? 'step' : null"
              >
                <span>{{ index + 1 }}</span
                >{{ label }}
              </span>
            }
          </nav>
          <p class="step-count" aria-live="polite">Step {{ step() }} of 4</p>
          @if (error()) {
            <p class="form-error" role="alert">{{ error() }}</p>
          }
          @if (step() === 1) {
            <section class="step-body" aria-labelledby="combine-step-title">
              <h3 id="combine-step-title">Select original purchase</h3>
              <app-select-picker
                label="Original purchase or existing payment group"
                [searchable]="true"
                [options]="targets()"
                [value]="target()"
                (valueChange)="chooseTarget($event)"
              />
              @if (target()) {
                <p class="step-note">{{ selectedTargetLabel() }}</p>
              }
            </section>
            <div class="step-actions">
              <button class="btn" type="button" [disabled]="busy()" (click)="closed.emit()">
                Cancel
              </button>
              <button
                class="btn btn-primary"
                type="button"
                [disabled]="!target()"
                (click)="step.set(2)"
              >
                Continue
              </button>
            </div>
          } @else if (step() === 2) {
            <section class="step-body" aria-labelledby="combine-step-title">
              <h3 id="combine-step-title">Select related recorded payments</h3>
              <label
                >Search recorded payments<input
                  type="search"
                  [formControl]="search"
                  placeholder="Merchant, date, amount or source"
              /></label>
              <fieldset>
                <legend>Eligible recorded payments</legend>
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
                } @empty {
                  <p class="step-note">No additional eligible recorded payments are available.</p>
                }
              </fieldset>
              @if (limit() < available().length) {
                <button class="btn" type="button" (click)="limit.set(limit() + 20)">
                  Show more recorded payments
                </button>
              }
              @if (group(); as current) {
                <details class="group-management">
                  <summary>Manage {{ current.memberIds.length }} current payments</summary>
                  @for (entry of preview().slice(0, memberLimit()); track entry.id) {
                    @if (current.memberIds.includes(entry.id)) {
                      <div class="group-member">
                        <span
                          >{{ entry.merchant || entry.transactionDate }} ·
                          {{ store.sourceDetail(entry.cardId) }} ·
                          {{ money(entry.amountMinor) }}</span
                        >
                        <button
                          class="btn"
                          type="button"
                          [disabled]="busy()"
                          (click)="remove(entry.id)"
                        >
                          Remove
                        </button>
                      </div>
                    }
                  }
                  @if (memberLimit() < current.memberIds.length) {
                    <button class="btn" type="button" (click)="memberLimit.set(memberLimit() + 20)">
                      Show more members
                    </button>
                  }
                  <button class="btn" type="button" [disabled]="busy()" (click)="dissolve()">
                    Dissolve group, keep every payment
                  </button>
                </details>
              }
            </section>
            <div class="step-actions">
              <button class="btn" type="button" (click)="step.set(1)">Back</button>
              <button
                class="btn btn-primary"
                type="button"
                [disabled]="preview().length < 2"
                (click)="step.set(3)"
              >
                Review grouping
              </button>
            </div>
          } @else if (step() === 3) {
            <section class="step-body" aria-labelledby="combine-step-title">
              <h3 id="combine-step-title">Review grouping</h3>
              <label>Group title / merchant<input [formControl]="title" maxlength="150" /></label>
              <label
                >Actual bill total (optional)<input [formControl]="bill" inputmode="decimal"
              /></label>
              <app-payment-breakdown [entries]="preview()" [billTotalMinor]="billValue()" />
            </section>
            <div class="step-actions">
              <button class="btn" type="button" (click)="step.set(2)">Back</button>
              <button class="btn btn-primary" type="button" (click)="reviewSave()">
                Continue to save
              </button>
            </div>
          } @else {
            <section class="step-body" aria-labelledby="combine-step-title">
              <h3 id="combine-step-title">Save payment group</h3>
              <p class="step-note">
                {{ preview().length }} recorded payments · {{ money(previewTotal()) }}
              </p>
              @for (entry of preview(); track entry.id) {
                <p class="review-entry">
                  {{ entry.merchant || 'Purchase' }} · {{ entry.transactionDate }} ·
                  {{ store.sourceDetail(entry.cardId) }} · {{ money(entry.amountMinor) }}
                </p>
              }
              <app-payment-breakdown [entries]="preview()" [billTotalMinor]="billValue()" />
              <p class="step-note">
                Grouping existing payments does not create another transaction or debit.
              </p>
            </section>
            <div class="step-actions">
              <button class="btn" type="button" [disabled]="busy()" (click)="step.set(3)">
                Back
              </button>
              <button class="btn" type="button" [disabled]="busy()" (click)="closed.emit()">
                Cancel
              </button>
              <button
                class="btn btn-primary"
                type="button"
                [disabled]="busy() || preview().length < 2"
                (click)="save()"
              >
                {{ busy() ? 'Saving…' : 'Save payment group' }}
              </button>
            </div>
          }
        }
      </div>
    </app-profile-modal>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .combine-flow {
      display: grid;
      min-width: 0;
      gap: 0.65rem;
    }
    .steps {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0.35rem;
      padding-bottom: 0.6rem;
      border-bottom: 1px solid var(--line);
    }
    .steps > span {
      display: grid;
      justify-items: center;
      gap: 0.25rem;
      color: var(--muted);
      font-size: 0.68rem;
      text-align: center;
      overflow-wrap: anywhere;
    }
    .steps > span > span {
      display: grid;
      width: 1.65rem;
      aspect-ratio: 1;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 50%;
    }
    .steps > .current {
      color: var(--accent);
      font-weight: 700;
    }
    .steps > .current > span {
      border-color: var(--accent);
      color: var(--on-accent);
      background: var(--accent);
    }
    .step-count,
    .step-note {
      margin: 0;
      color: var(--muted);
      font-size: 0.82rem;
      overflow-wrap: anywhere;
    }
    .step-body {
      display: grid;
      min-width: 0;
      gap: 0.75rem;
    }
    .step-body h3 {
      margin: 0;
      font-size: 1rem;
    }
    .step-body label {
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
    .step-actions {
      position: sticky;
      bottom: 0;
      z-index: 1;
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.55rem;
      margin-inline: -1rem;
      padding: 0.75rem 1rem max(0.75rem, env(safe-area-inset-bottom));
      border-top: 1px solid var(--line);
      background: var(--surface);
    }
    .step-actions .btn {
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .empty-state {
      display: grid;
      gap: 0.75rem;
      min-width: 0;
    }
    .empty-state h3,
    .empty-state p,
    .review-entry {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .group-management {
      display: grid;
      gap: 0.5rem;
    }
    .group-management summary {
      min-height: 44px;
      align-content: center;
      cursor: pointer;
    }
    .group-member {
      display: flex;
      min-width: 0;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      padding-block: 0.45rem;
      border-bottom: 1px solid var(--line);
    }
    .group-member > span {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    fieldset {
      min-width: 0;
      border: 1px solid var(--line);
    }
    button {
      min-height: 44px;
    }
    @media (max-width: 24rem) {
      .steps > span {
        font-size: 0.6rem;
      }
      .step-actions {
        justify-content: stretch;
      }
      .step-actions > .btn {
        flex: 1 1 7rem;
      }
    }
  `,
})
export class PaymentGroupsPanel {
  readonly store = inject(CardNestStore);
  readonly groupId = input('');
  readonly closed = output<void>();
  readonly addTransaction = output<void>();
  readonly stepLabels = ['Purchase', 'Payments', 'Review', 'Save'];
  readonly step = signal(1);
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
  readonly targetEntries = computed(() => this.targets().slice(1));
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
  readonly previewTotal = computed(() =>
    this.preview().reduce((total, entry) => total + entry.amountMinor, 0),
  );
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
  }
  chooseTarget(id: string): void {
    this.target.set(id);
    this.selected.set(new Set());
    this.step.set(1);
    const group = this.group();
    this.title.setValue(group?.title ?? '');
    this.bill.setValue(group?.billTotalMinor == null ? '' : String(group.billTotalMinor / 100));
  }
  selectedTargetLabel(): string {
    const target = this.targets().find((entry) => entry.value === this.target());
    return target && 'detail' in target ? target.detail : '';
  }
  reviewSave(): void {
    const bill = this.billValue();
    if (this.bill.value.trim() && bill === null) {
      this.error.set('Enter a valid bill total.');
      return;
    }
    this.error.set('');
    this.step.set(4);
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
