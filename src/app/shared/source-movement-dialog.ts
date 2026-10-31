import { Component, OnInit, computed, effect, inject, input, output, signal } from '@angular/core';
import { BalanceTiming, SourceTransfer } from '../core/models/domain';
import { CardNestStore } from '../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../core/services/money';
import { indiaTodayIso } from '../core/services/india-date';
import {
  bankCashTracked,
  isBankOrCash,
  needsBaselineConfirmation,
  savedTimingAnswer,
} from '../core/services/source-balance';
import { SnackbarService } from '../core/services/snackbar.service';
import { AppIcon } from './app-icon';
import { AppSelectOption, AppSelectPicker } from './app-select-picker';

export type SourceMovementMode = 'RECEIPT' | 'TRANSFER' | 'BALANCE' | 'ADD_MONEY';

/** Manual source movements and audited balance adjustments. */
@Component({
  selector: 'app-source-movement-dialog',
  imports: [AppIcon, AppSelectPicker],
  template: `
    <div
      class="movement-backdrop"
      tabindex="-1"
      (click)="close()"
      (keydown.escape)="$event.stopPropagation(); close()"
    >
      <section
        class="panel movement-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="movement-title"
        tabindex="-1"
        (click)="$event.stopPropagation()"
        (keydown)="$event.stopPropagation()"
      >
        <header class="movement-heading">
          <div>
            <p class="eyebrow">{{ eyebrow() }}</p>
            <h2 id="movement-title">{{ title() }}</h2>
          </div>
          <button type="button" (click)="close()" aria-label="Close">
            <app-icon name="close" />
          </button>
        </header>
        <form (submit)="submit($event)">
          @if (mode() === 'TRANSFER') {
            <app-select-picker
              [label]="loan() ? 'Paid from' : 'From'"
              [options]="accountOptions()"
              [value]="fromId()"
              (valueChange)="fromId.set($event)"
            />
            @if (loan()) {
              <p class="movement-note">
                Purpose: loan / EMI repayment. It leaves this account only and is not spending; loan
                schedules are not changed.
              </p>
            } @else {
              <app-select-picker
                label="To"
                [options]="accountOptions()"
                [value]="toId()"
                (valueChange)="toId.set($event)"
              />
            }
          }
          <label
            >{{
              mode() === 'BALANCE'
                ? 'Actual current balance (INR)'
                : mode() === 'ADD_MONEY'
                  ? 'Amount to add (INR)'
                  : 'Amount (INR)'
            }}<input
              inputmode="decimal"
              [value]="amount()"
              (input)="amount.set(value($event))"
              required
          /></label>
          @if (mode() === 'RECEIPT' || mode() === 'TRANSFER') {
            <label
              >Date<input type="date" [value]="date()" (input)="date.set(value($event))" required
            /></label>
          }
          @if (mode() === 'RECEIPT' || mode() === 'TRANSFER') {
            <label
              >Time (optional)<input type="time" [value]="time()" (input)="time.set(value($event))"
            /></label>
          }
          @if (timingNeeded()) {
            <fieldset class="timing-choice">
              <legend>This may already be included in a confirmed balance.</legend>
              <label class="choice"
                ><input
                  type="radio"
                  name="movement-timing"
                  [checked]="timing() === 'AFTER_BASELINE'"
                  (change)="timing.set('AFTER_BASELINE')"
                /><span>It happened after that balance — update the balance</span></label
              >
              <label class="choice"
                ><input
                  type="radio"
                  name="movement-timing"
                  [checked]="timing() === 'INCLUDED_IN_BASELINE'"
                  (change)="timing.set('INCLUDED_IN_BASELINE')"
                /><span>It is already included in that balance — record only</span></label
              >
            </fieldset>
            <label class="timing-review">
              <input type="checkbox" [checked]="timingReviewed()" (change)="reviewTiming($event)" />
              I checked the timing. Updating a movement already included in the balance would count
              it twice.
            </label>
            <p class="movement-note" role="status">
              {{
                timing() === 'INCLUDED_IN_BASELINE'
                  ? 'Record only: this movement is already included. No balance change will be applied.'
                  : 'Update balances: confirm that this movement happened after the saved balance.'
              }}
            </p>
          }
          @if (mode() === 'RECEIPT') {
            <app-select-picker
              label="Category"
              [options]="receiptCategoryOptions()"
              [value]="categoryId()"
              (valueChange)="categoryId.set($event)"
            />
          }
          <label
            >{{
              mode() === 'BALANCE' || mode() === 'ADD_MONEY'
                ? 'Note (optional)'
                : 'Description (optional)'
            }}<input
              maxlength="100"
              [value]="description()"
              (input)="description.set(value($event))"
          /></label>
          @if (mode() === 'BALANCE' && balancePreview(); as preview) {
            <p class="movement-note">{{ preview }}</p>
          }
          @if (mode() === 'ADD_MONEY' && balancePreview(); as preview) {
            <p class="movement-note">{{ preview }}</p>
          }
          @if (mode() === 'TRANSFER' && !loan()) {
            <p class="movement-note">
              {{
                editing()
                  ? 'Saving changes updates both balances together.'
                  : 'A transfer is never counted as spending or income. Any applicable balance changes commit together.'
              }}
            </p>
          }
          @if (error(); as message) {
            <p class="movement-error" role="alert">{{ message }}</p>
          }
          <div class="movement-actions">
            <button class="btn" type="button" (click)="close()">Cancel</button>
            <button
              class="btn btn-primary"
              type="submit"
              [disabled]="saving() || (timingNeeded() && (!timing() || !timingReviewed()))"
            >
              {{ saving() ? 'Saving…' : submitLabel() }}
            </button>
          </div>
        </form>
      </section>
    </div>
  `,
  styles: `
    .movement-backdrop {
      position: fixed;
      z-index: 1050;
      inset: 0;
      display: grid;
      place-items: center;
      padding: calc(env(safe-area-inset-top) + 1rem) max(1rem, env(safe-area-inset-right))
        max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
      background: rgb(10 25 18 / 68%);
      backdrop-filter: blur(4px);
    }
    .movement-dialog {
      display: grid;
      width: min(100%, 28rem);
      max-height: 100%;
      gap: 0.8rem;
      overflow: auto;
      padding: 1.1rem;
    }
    .movement-heading {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .movement-heading h2 {
      margin: 0;
      font-size: 1.1rem;
    }
    .movement-heading .eyebrow {
      margin: 0;
    }
    .movement-heading > button {
      display: grid;
      width: 44px;
      height: 44px;
      flex: 0 0 auto;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 0.7rem;
      background: var(--panel);
      color: var(--ink);
    }
    form {
      display: grid;
      gap: 0.7rem;
    }
    label {
      display: grid;
      gap: 0.3rem;
      font-size: 0.8rem;
    }
    .timing-choice {
      display: grid;
      gap: 0.4rem;
      margin: 0;
      padding: 0.6rem 0.7rem;
      border: 1px solid var(--line);
      border-radius: 0.6rem;
      font-size: 0.78rem;
    }
    .timing-choice .choice {
      display: flex;
      align-items: flex-start;
      justify-content: flex-start;
      gap: 0.65rem;
      min-height: 44px;
    }
    .timing-choice input[type='radio'],
    .timing-review input {
      width: 1.1rem;
      height: 1.1rem;
      min-width: 1.1rem;
      min-height: 1.1rem;
      flex: 0 0 1.1rem;
      margin: 0.15rem 0 0;
      padding: 0;
      accent-color: var(--accent);
    }
    .timing-review {
      display: flex;
      align-items: flex-start;
      gap: 0.65rem;
    }
    .movement-note,
    .movement-error {
      margin: 0;
      font-size: 0.78rem;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .movement-error {
      color: var(--danger);
    }
    .movement-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.5rem;
    }
  `,
})
export class SourceMovementDialog implements OnInit {
  readonly store = inject(CardNestStore);
  private readonly snackbar = inject(SnackbarService);
  readonly mode = input.required<SourceMovementMode>();
  readonly sourceId = input('');
  readonly presetFrom = input('');
  readonly presetTo = input('');
  readonly transfer = input<SourceTransfer | null>(null);
  readonly closed = output<void>();
  readonly fromId = signal('');
  readonly toId = signal('');
  readonly amount = signal('');
  readonly date = signal(indiaTodayIso());
  readonly time = signal('');
  readonly description = signal('');
  readonly categoryId = signal('income');
  readonly timing = signal<BalanceTiming | ''>('AFTER_BASELINE');
  readonly timingReviewed = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly editing = computed(() => !!this.transfer());
  readonly loan = computed(() => this.transfer()?.kind === 'LOAN_REPAYMENT');
  // Persisted ids are plain strings; a new draft simply starts from a UUID.
  private draftId: string = crypto.randomUUID();
  private initialized = false;
  constructor() {
    effect(() => {
      this.fromId();
      this.toId();
      this.sourceId();
      this.date();
      this.time();
      this.timing();
      this.store.paymentSources();
      this.store.bankCashTracking();
      this.timingReviewed.set(false);
    });
  }
  reviewTiming(event: Event): void {
    this.timingReviewed.set((event.target as HTMLInputElement).checked);
  }

  readonly timingNeeded = computed(() => {
    if (this.mode() === 'BALANCE') return false;
    const settings = this.store.bankCashTracking();
    const ids =
      this.mode() === 'RECEIPT'
        ? [this.sourceId()]
        : this.loan()
          ? [this.fromId()]
          : [this.fromId(), this.toId()];
    return ids.some((id) =>
      needsBaselineConfirmation(
        this.store.paymentSources().find((source) => source.id === id),
        settings,
        this.date(),
        this.time() || undefined,
        this.transfer(),
      ),
    );
  });

  readonly accountOptions = computed<readonly AppSelectOption[]>(() => [
    { value: '', label: 'Choose an account' },
    ...this.store
      .activePaymentSources()
      .filter(
        (source) => isBankOrCash(source) && bankCashTracked(source, this.store.bankCashTracking()),
      )
      .map((source) => ({
        value: source.id,
        label: this.store.sourceDetail(source.id),
        detail: `Balance ${formatMoney(source.balanceMinor ?? 0, 'INR')}`,
      })),
  ]);
  readonly receiptCategoryOptions = computed<readonly AppSelectOption[]>(() =>
    this.store
      .categories()
      .filter((category) => !category.archived && category.appliesTo !== 'EXPENSE')
      .map((category) => ({ value: category.id, label: category.name })),
  );
  readonly source = computed(() =>
    this.store.paymentSources().find((item) => item.id === this.sourceId()),
  );
  readonly eyebrow = computed(() =>
    this.source() ? this.store.sourceDetail(this.sourceId()) : 'Bank & Cash',
  );
  readonly title = computed(() => {
    if (this.mode() === 'BALANCE')
      return this.source()?.kind === 'CASH'
        ? 'Set current cash balance'
        : this.source()?.kind === 'MEAL'
          ? 'Set current wallet balance'
          : 'Set current balance';
    if (this.mode() === 'ADD_MONEY') return `Add money to ${this.source()?.nickname ?? 'account'}`;
    if (this.mode() === 'RECEIPT')
      return this.source()?.kind === 'CASH' ? 'Add cash' : 'Record incoming money';
    if (this.editing()) return this.loan() ? 'Edit loan repayment' : 'Edit transfer';
    const from = this.store.paymentSources().find((item) => item.id === this.fromId());
    const to = this.store.paymentSources().find((item) => item.id === this.toId());
    if (from?.kind === 'DEBIT' && to?.kind === 'CASH') return 'Withdraw cash from bank';
    if (from?.kind === 'CASH' && to?.kind === 'DEBIT') return 'Deposit cash into bank';
    return 'Transfer between my accounts';
  });
  readonly submitLabel = computed(() =>
    this.mode() === 'BALANCE'
      ? 'Save balance'
      : this.mode() === 'ADD_MONEY'
        ? 'Add money'
        : this.editing()
          ? 'Save changes'
          : 'Confirm',
  );
  readonly balancePreview = computed(() => {
    const source = this.source();
    const value = parseMoneyToMinor(this.amount());
    if (!source || value === null) return '';
    const initialized =
      bankCashTracked(source, this.store.bankCashTracking()) ||
      (source.kind === 'MEAL' && !source.noLimit && !!source.balanceCutoverAt);
    if (this.mode() === 'ADD_MONEY')
      return `Current ${formatMoney(source.balanceMinor ?? 0, 'INR')} + ${formatMoney(value, 'INR')} = ${formatMoney((source.balanceMinor ?? 0) + value, 'INR')}. This is an audited balance change, not income or spending.`;
    if (!initialized) return 'This sets the starting balance. Older entries are not replayed.';
    const correction = value - (source.balanceMinor ?? 0);
    return `Calculated ${formatMoney(source.balanceMinor ?? 0, 'INR')}. A ${correction < 0 ? '−' : '+'}${formatMoney(Math.abs(correction), 'INR')} correction is saved for audit; it is not income or spending.`;
  });

  ngOnInit(): void {
    this.initialise();
  }

  private initialise(): void {
    if (this.initialized) return;
    this.initialized = true;
    const transfer = this.transfer();
    if (transfer) {
      this.fromId.set(transfer.fromSourceId);
      this.toId.set(transfer.toSourceId ?? '');
      this.amount.set(String(transfer.amountMinor / 100));
      this.date.set(transfer.transferDate);
      this.time.set(transfer.transferTime?.slice(0, 5) ?? '');
      this.description.set(transfer.description ?? '');
      const answers = [transfer.fromSourceId, transfer.toSourceId].flatMap((id) => {
        const source = this.store.paymentSources().find((item) => item.id === id);
        return source && bankCashTracked(source, this.store.bankCashTracking())
          ? [savedTimingAnswer(source, this.store.bankCashTracking(), transfer)]
          : [];
      });
      this.timing.set(
        answers.length && answers.every((answer) => answer && answer === answers[0])
          ? answers[0]!
          : '',
      );
      this.draftId = transfer.id;
      return;
    }
    this.fromId.set(this.presetFrom());
    this.toId.set(this.presetTo());
    const source = this.source();
    if (this.mode() === 'BALANCE' && source?.balanceMinor !== undefined)
      this.amount.set(String(source.balanceMinor / 100));
    if (
      this.mode() === 'RECEIPT' &&
      !this.receiptCategoryOptions().some((o) => o.value === 'income')
    )
      this.categoryId.set('other');
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  close(): void {
    if (!this.saving()) this.closed.emit();
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.initialise();
    if (this.timingNeeded() && (!this.timing() || !this.timingReviewed())) {
      this.error.set(
        'Review and confirm whether this movement is already included in the balance.',
      );
      return;
    }
    const amount = parseMoneyToMinor(this.amount().trim());
    if (amount === null || (this.mode() !== 'BALANCE' && amount <= 0)) {
      this.error.set('Enter a valid amount.');
      return;
    }
    this.error.set(null);
    this.saving.set(true);
    const timing = this.timingNeeded() ? this.timing() || undefined : undefined;
    try {
      if (this.mode() === 'BALANCE') {
        await this.store.setSourceBalance(this.sourceId(), amount, this.description());
        this.snackbar.show('Balance saved. The correction is recorded for audit.');
      } else if (this.mode() === 'ADD_MONEY') {
        await this.store.addSourceBalance(this.sourceId(), amount, this.description());
        this.snackbar.show('Money added. The balance adjustment is recorded for audit.');
      } else if (this.mode() === 'RECEIPT') {
        const source = this.source();
        if (!source || !isBankOrCash(source)) throw new Error('Choose a bank account or cash.');
        await this.store.recordSourceReceipt({
          id: this.draftId,
          sourceId: source.id,
          amountMinor: amount,
          transactionDate: this.date(),
          transactionTime: this.time() || undefined,
          merchant:
            this.description().trim() ||
            (source.kind === 'CASH' ? 'Cash received' : 'Money received'),
          categoryId: this.categoryId() || 'other',
          balanceTiming: timing,
        });
        this.snackbar.show(source.kind === 'CASH' ? 'Cash added.' : 'Incoming money recorded.');
      } else {
        const saved = await this.store.saveTransfer(
          {
            id: this.draftId,
            fromSourceId: this.fromId(),
            toSourceId: this.loan() ? undefined : this.toId(),
            amountMinor: amount,
            transferDate: this.date(),
            transferTime: this.time() || undefined,
            description: this.description(),
            balanceTiming: timing,
          },
          this.editing() ? 'UPDATE' : 'CREATE',
        );
        this.snackbar.show(
          this.loan()
            ? `${formatMoney(saved.amountMinor, 'INR')} loan repayment saved.`
            : saved.effects?.length
              ? `${formatMoney(saved.amountMinor, 'INR')} moved. Both balances were updated together.`
              : 'Movement recorded without changing confirmed balances.',
        );
      }
      this.saving.set(false);
      this.closed.emit();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'The movement could not be saved.');
    } finally {
      this.saving.set(false);
    }
  }
}
