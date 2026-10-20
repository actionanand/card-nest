import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AppIcon } from '../../shared/app-icon';
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
  merchantTitle,
} from './sms-model';

function isReviewEntry(info: unknown): boolean {
  return (
    typeof info === 'object' &&
    info !== null &&
    'smsReviewEntry' in info &&
    info.smsReviewEntry === true
  );
}

@Component({
  selector: 'app-sms-sync',
  imports: [ReactiveFormsModule, AppIcon],
  templateUrl: './sms-sync.html',
  styleUrl: './sms-sync.scss',
  host: {
    '(document:keydown.escape)': 'closeEditor()',
    '(document:keydown)': 'trapFocus($event)',
    '(window:focus)': 'refreshAccess()',
    '(window:cardnest:back)': 'androidBack($event)',
  },
})
export class SmsSyncPage {
  readonly sync = inject(SmsReviewService);
  readonly store = inject(CardNestStore);
  // Router `info` is transient: refresh, restored history and ordinary app launch
  // cannot replay the explicit link action and request permission on startup.
  private entryPermissionPending = isReviewEntry(inject(Router).currentNavigation()?.extras.info);
  readonly range = signal(30);
  readonly search = signal('');
  readonly kind = signal('ALL');
  readonly state = signal('PENDING');
  readonly sourceFilter = signal('');
  readonly from = signal('');
  readonly to = signal('');
  readonly advanced = signal(false);
  readonly loading = signal(false);
  readonly notice = signal('');
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.sync.total() / 200)));
  readonly scanLabel = computed(() =>
    this.sync.busy()
      ? 'Scanning…'
      : this.sync.status()?.more || this.sync.status()?.backgroundPending
        ? 'Resume scan'
        : 'Scan now',
  );
  readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('reviewDialog');
  readonly title = merchantTitle;
  readonly filterChips = computed(() =>
    [
      { key: 'search', label: this.search() && `Search: ${this.search()}` },
      { key: 'source', label: this.sourceFilter() && `Source: ${this.sourceFilter()}` },
      { key: 'kind', label: this.kind() !== 'ALL' && this.label(this.kind()) },
      { key: 'state', label: this.state() !== 'ALL' && this.label(this.state()) },
      { key: 'from', label: this.from() && `From ${this.from()}` },
      { key: 'to', label: this.to() && `To ${this.to()}` },
    ].filter((chip) => chip.label),
  );
  removeFilter(key: string): void {
    const controls: Record<string, { set(value: string): void }> = {
      search: this.search,
      source: this.sourceFilter,
      kind: this.kind,
      state: this.state,
      from: this.from,
      to: this.to,
    };
    controls[key]?.set(key === 'kind' || key === 'state' ? 'ALL' : '');
    this.applyFilters();
  }
  clearFilters(): void {
    this.search.set('');
    this.sourceFilter.set('');
    this.kind.set('ALL');
    this.state.set('ALL');
    this.from.set('');
    this.to.set('');
    this.applyFilters();
  }
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
        from: this.from(),
        to: this.to(),
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
  sourceLabel(candidate: SmsCandidate): string {
    const ids = candidate.item
      ? eligibleSources(candidate.item, this.store.cards(), this.store.paymentSources())
      : [];
    if (ids.length === 1) {
      const card = this.store.cards().find((card) => card.id === ids[0]);
      const wallet = this.store.paymentSources().find((source) => source.id === ids[0]);
      return `${card?.nickname ?? wallet?.nickname} ${card?.lastDigits || wallet?.lastDigits ? `••${card?.lastDigits ?? wallet?.lastDigits}` : ''}${card?.archived ? ' · archived' : ''}`;
    }
    return ids.length > 1
      ? `Ambiguous · ${ids.length} matching sources; choose one`
      : 'Unmatched · select a source';
  }
  readonly importable = computed(() => {
    const item = this.selected()?.item;
    return !!item && !!ledgerType(item);
  });
  readonly accessTitle = computed(() => {
    if (this.sync.requestingPermission()) return 'Requesting permission';
    if (this.sync.changingSync()) return 'Updating sync…';
    const status = this.sync.status();
    if (!status) return 'Checking SMS access';
    if (status.permission === 'granted') return status.enabled ? 'Sync on' : 'Sync off';
    const labels: Record<string, string> = {
      'not requested': 'Not requested',
      denied: 'Denied',
      unavailable: 'Permission unavailable or restricted',
      revoked: 'Revoked after a previous grant',
      requesting: 'Requesting permission',
    };
    return labels[status.permission] ?? 'SMS access unavailable';
  });
  constructor() {
    effect((cleanup) => {
      const dialog = this.dialog()?.nativeElement;
      if (!dialog || !this.selected()) return;
      const overflow = document.body.style.overflow;
      const rootOverflow = document.documentElement.style.overflow;
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      queueMicrotask(() => {
        if (dialog.isConnected) dialog.querySelector<HTMLElement>('h2')?.focus();
      });
      cleanup(() => {
        document.body.style.overflow = overflow;
        document.documentElement.style.overflow = rootOverflow;
        if (typeof dialog.close === 'function') dialog.close();
      });
    });
    effect(() => {
      const available = !this.sync.lock.locked() && this.sync.lock.foreground();
      if (available)
        untracked(() => {
          void this.run(async () => {
            if (this.entryPermissionPending) {
              this.entryPermissionPending = false;
              await this.sync.enterFromReview(this.range());
            }
            await this.sync.refresh();
          });
        });
      else {
        this.selected.set(null);
        this.sync.candidates.set([]);
        this.text.reset();
      }
    });
  }
  androidBack(event: Event): void {
    if (this.selected()) {
      event.preventDefault();
      this.closeEditor();
    }
  }
  trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const dialog = this.dialog()?.nativeElement;
    if (!dialog) return;
    const controls = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex="0"]',
      ),
    ].filter((control) => control.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement?.id === 'sms-review-heading')
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
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
  dateTime(value: string): string {
    return Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'Date unavailable';
  }
  label(value: string): string {
    return value
      .toLowerCase()
      .replaceAll('_', ' ')
      .replace(/^./, (letter) => letter.toUpperCase());
  }
  async run(work: () => Promise<void>): Promise<void> {
    this.error.set('');
    this.loading.set(true);
    try {
      await work();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Operation failed. Retry is safe.');
    } finally {
      this.loading.set(false);
    }
  }
  enable(): void {
    void this.run(() => this.sync.enable(this.range()));
  }
  toggleSync(event: Event): void {
    const input = event.target as HTMLInputElement;
    const enabled = input.checked;
    // Reflect confirmed native state, including a denied/failed request returning OFF.
    input.checked = this.sync.syncEnabled();
    if (enabled) this.enable();
    else this.disable();
  }
  refreshAccess(): void {
    if (!this.sync.lock.locked() && this.sync.lock.foreground())
      void this.run(() => this.sync.refreshAccess());
  }
  openSettings(): void {
    void this.run(() => this.sync.openSettings());
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
    this.error.set('');
    this.notice.set('');
    this.selected.set(candidate);
    this.related.set([]);
    void this.run(async () => {
      const related = await this.sync.relatedFor(candidate);
      if (this.selected()?.id === candidate.id) this.related.set(related);
    });
    this.evidenceTarget.reset();
    this.editor.reset({
      source: candidate.item
        ? (() => {
            const ids = eligibleSources(
              candidate.item,
              this.store.cards(),
              this.store.paymentSources(),
            );
            return ids.length === 1 ? ids[0] : '';
          })()
        : '',
      amount: String((candidate.item?.amountMinor ?? 0) / 100),
      merchant: merchantTitle(candidate.item, candidate.kind),
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
    if (this.saving()) return;
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
      ? [
          ...new Map(
            [
              ...existingSuggestions(
                item,
                this.editor.controls.source.value,
                this.store.transactions(),
              ),
              ...existingSuggestions(
                {
                  ...item,
                  amountMinor:
                    parseMoneyToMinor(this.editor.controls.amount.value) ?? item.amountMinor,
                  eventDate: this.editor.controls.transactionDate.value,
                },
                this.editor.controls.source.value,
                this.store.transactions(),
              ),
            ].map((transaction) => [transaction.id, transaction]),
          ).values(),
        ].map((t) => ({
          id: t.id,
          label: `${t.transactionDate} · ${t.merchant ?? t.type} · ${this.money(t.amountMinor)}`,
        }))
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
        this.notice.set(this.sync.notice() || 'Transaction approved and saved.');
        this.saving.set(false);
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
