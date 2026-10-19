import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { CardNestStore } from '../../core/services/card-nest-store';
import { parseMoneyToMinor } from '../../core/services/money';
import { SmsReviewService } from './sms-review.service';
import {
  SmsCandidate,
  SmsKind,
  ReconciliationChoice,
  eligibleSources,
  existingSuggestions,
  ledgerType,
} from './sms-model';

@Component({
  selector: 'app-sms-sync',
  imports: [ReactiveFormsModule],
  templateUrl: './sms-sync.html',
  styleUrl: './sms-sync.scss',
  host: { '(document:keydown.escape)': 'closeEditor()' },
})
export class SmsSyncPage {
  readonly sync = inject(SmsReviewService);
  readonly store = inject(CardNestStore);
  readonly range = signal(30);
  readonly search = signal('');
  readonly kind = signal('ALL');
  readonly state = signal('PENDING');
  readonly sourceFilter = signal('');
  readonly selected = signal<SmsCandidate | null>(null);
  readonly related = signal<readonly SmsCandidate[]>([]);
  readonly error = signal('');
  readonly saving = signal(false);
  readonly text = new FormControl('', {
    nonNullable: true,
    validators: [Validators.maxLength(16384)],
  });
  readonly editor = new FormGroup({
    source: new FormControl('', { nonNullable: true, validators: Validators.required }),
    amount: new FormControl('', { nonNullable: true, validators: Validators.required }),
    merchant: new FormControl('', { nonNullable: true, validators: Validators.maxLength(100) }),
    existing: new FormControl('', { nonNullable: true }),
    reconciliation: new FormControl<ReconciliationChoice>('PENDING', {
      nonNullable: true,
    }),
    separate: new FormControl(false, { nonNullable: true }),
    statementDate: new FormControl('', { nonNullable: true }),
    statementDue: new FormControl('', { nonNullable: true }),
    transactionDate: new FormControl('', { nonNullable: true, validators: Validators.required }),
    category: new FormControl('other', { nonNullable: true, validators: Validators.required }),
    relatedPurchase: new FormControl('', { nonNullable: true }),
  });
  readonly kinds: readonly SmsKind[] = [
    'PURCHASE',
    'CARD_PAYMENT_RECEIVED',
    'PAYMENT_INITIATED',
    'CASHBACK',
    'REFUND',
    'PLUXEE_PURCHASE',
    'PLUXEE_TOPUP',
    'FASTAG_TOLL',
    'FASTAG_TOPUP',
    'LOAN_DEBIT',
    'BANK_TRANSFER',
    'BANK_DEBIT',
    'BANK_CREDIT',
    'STATEMENT',
    'PAYMENT_REMINDER',
    'LOAN_REMINDER',
  ];
  readonly visible = this.sync.candidates;
  applyFilters(): void {
    void this.run(() =>
      this.sync.filterReview({
        state: this.state(),
        kind: this.kind(),
        search: this.search(),
        source: this.sourceFilter(),
      }),
    );
  }
  page(direction: number): void {
    void this.run(() => this.sync.turnPage(direction));
  }
  rejectPage(): void {
    void this.run(() => this.sync.rejectBatch(this.visible()));
  }
  readonly sources = computed(() => {
    const item = this.selected()?.item;
    if (!item) return [];
    const suggested = eligibleSources(item, this.store.cards(), this.store.paymentSources());
    const wallets = item.kind.startsWith('PLUXEE')
      ? 'MEAL'
      : item.kind.startsWith('FASTAG')
        ? 'FASTAG'
        : '';
    const available = wallets
      ? this.store.paymentSources().filter((s) => s.kind === wallets)
      : this.store.cards().filter((c) => !c.deletedAt);
    return available.map((s) => ({
      id: s.id,
      label: this.store.sourceDetail(s.id),
      suggested: suggested.includes(s.id),
    }));
  });
  readonly importable = computed(() => {
    const item = this.selected()?.item;
    return !!item && !!ledgerType(item);
  });
  constructor() {
    effect(() => {
      const available = !this.sync.lock.locked() && this.sync.lock.foreground();
      if (available)
        untracked(() => {
          void this.run(() => this.sync.refresh());
        });
      else {
        this.selected.set(null);
        this.sync.candidates.set([]);
        this.text.reset();
      }
    });
  }
  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
  setRange(event: Event): void {
    this.range.set(Number(this.value(event)));
  }
  money(value: number | undefined): string {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(
      (value ?? 0) / 100,
    );
  }
  date(value: number): string {
    return value ? new Date(value).toLocaleString() : 'Not completed';
  }
  label(value: string): string {
    return value.replaceAll('_', ' ');
  }
  async run(work: () => Promise<void>): Promise<void> {
    this.error.set('');
    try {
      await work();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Operation failed. Retry is safe.');
    }
  }
  enable(): void {
    void this.run(() => this.sync.enable(this.range()));
  }
  scan(): void {
    void this.run(() => this.sync.scan());
  }
  disable(): void {
    void this.run(() => this.sync.disable());
  }
  cancel(): void {
    void this.run(() => this.sync.cancel());
  }
  paste(): void {
    void this.run(async () => {
      await this.sync.paste(this.text.value);
      this.text.reset();
    });
  }
  open(candidate: SmsCandidate): void {
    this.selected.set(candidate);
    this.related.set([]);
    void this.run(async () => {
      const related = await this.sync.relatedFor(candidate);
      if (this.selected()?.id === candidate.id) this.related.set(related);
    });
    this.evidenceTarget.reset();
    this.editor.reset({
      source: '',
      amount: String((candidate.item?.amountMinor ?? 0) / 100),
      merchant: candidate.item?.merchant ?? '',
      existing: '',
      reconciliation: 'PENDING',
      separate: false,
      statementDate: '',
      statementDue: '',
      transactionDate: candidate.item?.eventDate ?? '',
      category:
        candidate.kind === 'CARD_PAYMENT_RECEIVED'
          ? 'payment'
          : ['CASHBACK', 'REFUND', 'PLUXEE_TOPUP', 'FASTAG_TOPUP'].includes(candidate.kind)
            ? 'contra-expenses'
            : 'other',
      relatedPurchase: '',
    });
    queueMicrotask(() => document.getElementById('sms-review-heading')?.focus());
  }
  closeEditor(): void {
    const id = this.selected()?.id;
    if (!id) return;
    this.selected.set(null);
    queueMicrotask(() =>
      (
        document.getElementById(`review-${id}`) ?? document.getElementById('sms-inbox-title')
      )?.focus(),
    );
  }
  matches(): readonly { id: string; label: string }[] {
    const item = this.selected()?.item;
    if (this.editor.controls.reconciliation.value === 'REPAIR_EXISTING')
      return this.store
        .transactions()
        .filter((t) => t.cardId === this.editor.controls.source.value && t.type === 'CREDIT')
        .map((t) => ({
          id: t.id,
          label: `${t.transactionDate} · ${t.merchant ?? t.type} · ${this.money(t.amountMinor)}`,
        }));
    return item
      ? existingSuggestions(item, this.editor.controls.source.value, this.store.transactions()).map(
          (t) => ({
            id: t.id,
            label: `${t.transactionDate} · ${t.merchant ?? t.type} · ${this.money(t.amountMinor)}`,
          }),
        )
      : [];
  }
  decide(candidate: SmsCandidate, state: 'REJECTED' | 'DEFERRED' | 'IGNORED' | 'PENDING'): void {
    void this.run(async () => {
      await this.sync.decide(candidate, state);
      this.closeEditor();
    });
  }
  approve(event: Event): void {
    event.preventDefault();
    const candidate = this.selected();
    if (!candidate || this.saving()) return;
    const value = this.editor.getRawValue();
    const amount = parseMoneyToMinor(value.amount);
    const statementDue = parseMoneyToMinor(value.statementDue);
    if (value.reconciliation === 'FULLY_PAID' && statementDue === null) {
      this.error.set('Enter a valid original statement due amount.');
      return;
    }
    if (!this.editor.valid || !amount) {
      this.error.set('Choose a source and enter a positive amount.');
      return;
    }
    this.saving.set(true);
    void this.run(async () => {
      try {
        await this.sync.approve(
          candidate,
          value.source,
          amount,
          value.merchant,
          value.existing,
          value.reconciliation,
          value.separate,
          value.statementDate,
          statementDue ?? 0,
          {
            transactionDate: value.transactionDate,
            categoryId: value.category,
            relatedTransactionId: value.relatedPurchase || undefined,
          },
        );
        this.closeEditor();
      } finally {
        this.saving.set(false);
      }
    });
  }
  readonly evidenceTarget = new FormControl('', { nonNullable: true });
  evidenceTargets(): readonly { id: string; label: string }[] {
    return [
      ...this.store
        .transactions()
        .filter((t) => t.type === 'PAYMENT')
        .map((t) => ({
          id: `TRANSACTION:${t.id}`,
          label: `Existing payment · ${this.store.sourceDetail(t.cardId)} · ${t.transactionDate} · ${this.money(t.amountMinor)}`,
        })),
      ...this.store
        .emiInstallments()
        .filter((i) => !i.paid && i.id)
        .map((i) => ({
          id: `INSTALLMENT:${i.id}`,
          label: `EMI ${i.installmentNumber} · ${i.dueDate} · ${this.money(i.totalMinor)}`,
        })),
      ...this.store.loans().map((loan) => ({
        id: `LOAN:${loan.id}`,
        label: `Loan · ${loan.name} · ${this.money(loan.installmentMinor)}`,
      })),
    ];
  }
  confirmEvidence(): void {
    const candidate = this.selected();
    const [kind, ...ids] = this.evidenceTarget.value.split(':');
    if (!candidate || !['TRANSACTION', 'INSTALLMENT', 'LOAN'].includes(kind)) return;
    void this.run(async () => {
      await this.sync.reconcileEvidence(
        candidate,
        ids.join(':'),
        kind as 'TRANSACTION' | 'INSTALLMENT' | 'LOAN',
      );
      this.closeEditor();
    });
  }
}
