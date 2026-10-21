import {
  Component,
  DestroyRef,
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
import { Capacitor } from '@capacitor/core';
import { SmsSwipe } from './sms-swipe';
import { AppIcon } from '../../shared/app-icon';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';
import { SnackbarService } from '../../core/services/snackbar.service';
import { lockDocumentScroll } from '../../shared/document-scroll-lock';
import { CardNestStore } from '../../core/services/card-nest-store';
import { parseMoneyToMinor } from '../../core/services/money';
import { SmsReviewService } from './sms-review.service';
import { SmsTypePicker } from './sms-type-picker';
import { INITIAL_MULTIPLE_KINDS, reviewFilters } from './sms-review-filters';
import { matchExisting, walletComparison } from './sms-matching';
import {
  SmsCandidate,
  SmsKind,
  ReconciliationChoice,
  eligibleSources,
  existingSuggestions,
  ledgerType,
  merchantTitle,
  suspectEvidence,
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
  imports: [ReactiveFormsModule, AppIcon, AppSelectPicker, SmsTypePicker, SmsSwipe],
  templateUrl: './sms-sync.html',
  styleUrl: './sms-sync.scss',
  host: {
    '(document:keydown.escape)': 'escape()',
    '(document:keydown)': 'trapFocus($event)',
    '(window:focus)': 'refreshAccess()',
    '(window:cardnest:back)': 'androidBack($event)',
  },
})
export class SmsSyncPage {
  readonly sync = inject(SmsReviewService);
  readonly store = inject(CardNestStore);
  private readonly snackbar = inject(SnackbarService);
  readonly readFilter = signal('UNREAD');
  readonly hideAlreadyAdded = signal(true);
  readonly swipeEnabled = computed(
    () => Capacitor.getPlatform() === 'android' && (this.store.smsSwipeActionsEnabled?.() ?? false),
  );
  enableSwipeActions(): void {
    void this.run(() => this.store.setDurableUiPreference('sms_swipe_actions_enabled', true));
  }
  readonly confirmReadCount = signal<number | null>(null);
  readonly readDialog = viewChild<ElementRef<HTMLDialogElement>>('readDialog');
  readonly historyOptions: readonly AppSelectOption[] = [
    { value: '30', label: 'Last 30 days' },
    { value: '90', label: 'Last 90 days' },
    { value: '0', label: 'All available history' },
  ];
  readonly readOptions: readonly AppSelectOption[] = ['UNREAD', 'ALL', 'READ'].map((value) => ({
    value,
    label: value === 'ALL' ? 'All suggestions' : this.label(value),
  }));
  readonly kindOptions = computed<readonly AppSelectOption[]>(() => [
    { value: 'ALL', label: 'All types' },
    ...this.kinds.map((value) => ({ value, label: this.label(value) })),
  ]);
  readonly stateOptions: readonly AppSelectOption[] = [
    'ALL',
    'PENDING',
    'DEFERRED',
    'REJECTED',
    'IGNORED',
    'IMPORTED',
    'MATCHED_EXISTING',
    'ERROR',
  ].map((value) => ({ value, label: this.label(value) }));
  readonly categoryOptions = computed<readonly AppSelectOption[]>(() =>
    this.store.categories().map((category) => ({ value: category.id, label: category.name })),
  );
  sourceOptions(): readonly AppSelectOption[] {
    return [
      { value: '', label: 'Select a source' },
      ...this.sources().map((source) => ({
        value: source.id,
        label: source.label,
        detail: source.suggested ? 'Suggested — verify before approval' : undefined,
      })),
    ];
  }
  matchOptions(): readonly AppSelectOption[] {
    return [
      { value: '', label: 'Create a new entry after approval' },
      ...this.matches().map((match) => ({ value: match.id, label: match.label })),
    ];
  }
  purchaseOptions(): readonly AppSelectOption[] {
    return [
      { value: '', label: 'No confirmed original purchase' },
      ...this.store
        .transactions()
        .filter(
          (item) => item.type === 'PURCHASE' && item.cardId === this.editor.controls.source.value,
        )
        .map((item) => ({
          value: item.id,
          label: item.merchant ?? 'Purchase',
          detail: `${item.transactionDate} · ${this.money(item.amountMinor)}`,
        })),
    ];
  }
  evidenceOptions(): readonly AppSelectOption[] {
    return [
      { value: '', label: 'Select the verified existing record' },
      ...this.evidenceTargets().map((item) => ({ value: item.id, label: item.label })),
    ];
  }
  reconciliationOptions(): readonly AppSelectOption[] {
    const kind = this.selected()?.kind ?? '';
    return [
      {
        value: 'PENDING',
        label: 'Keep reconciliation pending',
        detail: 'Retain calculated balance',
      },
      {
        value: 'RETAIN_BALANCE',
        label: 'Historical wallet event',
        detail: 'Retain snapshot balance',
      },
      ...(kind.startsWith('PLUXEE') || kind.startsWith('FASTAG')
        ? [
            { value: 'REPAIR_EXISTING', label: 'Repair existing top-up amount' },
            { value: 'ADJUST_BALANCE', label: 'Apply documented wallet balance adjustment' },
          ]
        : []),
      ...(kind === 'CARD_PAYMENT_RECEIVED'
        ? [{ value: 'FULLY_PAID', label: 'Explicitly settle a chosen statement' }]
        : []),
    ];
  }
  selectHistory(value: string): void {
    this.range.set(Number(value));
  }
  // Router `info` is transient: refresh, restored history and ordinary app launch
  // cannot replay the explicit link action and request permission on startup.
  private entryPermissionPending = isReviewEntry(inject(Router).currentNavigation()?.extras.info);
  readonly range = signal(30);
  readonly search = signal('');
  readonly kind = signal('ALL');
  readonly typeMode = signal<'SINGLE' | 'MULTIPLE'>('SINGLE');
  readonly multipleKinds = signal<string[]>([]);
  readonly multipleInitialized = signal(false);
  changeTypeMode(mode: 'SINGLE' | 'MULTIPLE'): void {
    if (mode === 'MULTIPLE' && !this.multipleInitialized()) {
      this.multipleKinds.set([...INITIAL_MULTIPLE_KINDS]);
      this.multipleInitialized.set(true);
    }
    this.typeMode.set(mode);
  }
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
      ...(this.typeMode() === 'MULTIPLE'
        ? this.multipleKinds().map((kind) => ({
            key: `type:${kind}`,
            label: this.label(kind),
          }))
        : [{ key: 'kind', label: this.kind() !== 'ALL' && this.label(this.kind()) }]),
      { key: 'state', label: this.state() !== 'ALL' && this.label(this.state()) },
      { key: 'from', label: this.from() && `From ${this.from()}` },
      { key: 'to', label: this.to() && `To ${this.to()}` },
      { key: 'read', label: this.readFilter() !== 'ALL' && this.label(this.readFilter()) },
    ].filter((chip) => chip.label),
  );
  readonly typeChips = computed(() =>
    this.filterChips().filter((chip) => chip.key.startsWith('type:') || chip.key === 'kind'),
  );
  checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }
  importableCandidate(candidate: SmsCandidate): boolean {
    return !!candidate.item && !!ledgerType(candidate.item);
  }
  removeFilter(key: string): void {
    if (key.startsWith('type:')) {
      this.multipleKinds.update((kinds) => kinds.filter((kind) => kind !== key.slice(5)));
      this.applyFilters();
      return;
    }
    const controls: Record<string, { set(value: string): void }> = {
      search: this.search,
      source: this.sourceFilter,
      kind: this.kind,
      state: this.state,
      from: this.from,
      to: this.to,
      read: this.readFilter,
    };
    controls[key]?.set(key === 'kind' || key === 'state' || key === 'read' ? 'ALL' : '');
    this.applyFilters();
  }
  clearFilters(): void {
    this.search.set('');
    this.sourceFilter.set('');
    this.kind.set('ALL');
    this.typeMode.set('SINGLE');
    this.state.set('ALL');
    this.from.set('');
    this.to.set('');
    this.readFilter.set('ALL');
    this.applyFilters();
  }
  readonly selected = signal<SmsCandidate | null>(null);
  readonly related = signal<readonly SmsCandidate[]>([]);
  readonly error = signal('');
  readonly confirmBalance = signal(false);
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
    'SCHEDULED_CHARGE',
  ];
  readonly visible = this.sync.candidates;
  readonly possibleOnPage = computed(
    () =>
      this.visible().filter(
        (candidate) =>
          candidate.state === 'PENDING' &&
          !!candidate.item &&
          matchExisting(
            candidate.item,
            this.store.cards(),
            this.store.paymentSources(),
            this.store.transactions(),
          ).transactionIds.length > 0,
      ).length,
  );
  applyFilters(): void {
    void this.run(() =>
      this.sync.filterReview({
        state: this.state(),
        kind: this.kind(),
        mode: this.typeMode(),
        kinds: this.multipleKinds(),
        multipleInitialized: this.multipleInitialized(),
        search: this.search(),
        source: this.sourceFilter(),
        from: this.from(),
        to: this.to(),
        read: this.readFilter(),
        hideAlreadyAdded: this.hideAlreadyAdded(),
      }),
    );
  }
  page(direction: number): void {
    void this.run(() => this.sync.turnPage(direction));
  }
  rejectPage(): void {
    void this.run(async () => {
      await this.sync.rejectBatch(this.visible());
      this.snackbar.show('Selected suggestions rejected.', 'INFO');
    });
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
    if (candidate.state === 'IMPORTED') return 'Added from SMS · Recorded transaction';
    if (candidate.state === 'MATCHED_EXISTING')
      return 'Already added · Matched to existing transaction';
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
  matchReason(candidate: SmsCandidate): string {
    if (candidate.item && suspectEvidence(candidate.item))
      return 'Possible statement or scheduled-charge misclassification. Recheck the original SMS before adding. If already imported, inspect and explicitly correct the linked transaction in Activity; no automatic reversal is made.';
    if (candidate.state === 'IMPORTED')
      return 'Added after your approval. View the recorded transaction; this suggestion cannot be imported again.';
    if (candidate.state === 'MATCHED_EXISTING' && candidate.item && ledgerType(candidate.item)) {
      const target = this.store
        .transactions()
        .find((entry) => entry.id === candidate.transactionId);
      if (!target)
        return 'Linked record unavailable. The original review decision is retained; inspect Activity before recording anything again.';
      if (
        candidate.item &&
        (target.type !== ledgerType(candidate.item) ||
          target.amountMinor !== candidate.item.amountMinor ||
          target.transactionDate !== candidate.item.eventDate)
      )
        return 'The current ledger differs from the SMS evidence. The original review decision is retained; compare its current details in Activity.';
    }
    if (
      candidate.state === 'MATCHED_EXISTING' &&
      candidate.decision &&
      !candidate.decision.startsWith('AUTO_EXISTING:')
    )
      return 'Explicitly matched to an existing record. Your review decision and recorded financial details are retained.';
    if (candidate.decision) return candidate.decision.replace(/^AUTO_EXISTING: /, '');
    if (!candidate.item) return '';
    const match = matchExisting(
      candidate.item,
      this.store.cards(),
      this.store.paymentSources(),
      this.store.transactions(),
    );
    return match.confidence === 'HIGH_CONFIDENCE_EXISTING'
      ? 'An existing transaction may already cover this SMS. Confirm its link before adding another entry.'
      : match.confidence === 'NO_MATCH'
        ? ''
        : match.reason;
  }
  viewExisting(candidate: SmsCandidate): void {
    if (candidate.transactionId)
      void this.router.navigate(['/transactions'], {
        queryParams: { edit: candidate.transactionId },
      });
  }
  chooseInbox(state: string): void {
    this.state.set(state);
    if (state === 'ALL') this.hideAlreadyAdded.set(false);
    this.readFilter.set('ALL');
    this.applyFilters();
  }
  reevaluate(): void {
    void this.run(async () => {
      const before = this.sync.matchedTotal();
      await this.sync.refresh();
      const count = Math.max(0, this.sync.matchedTotal() - before);
      this.snackbar.show(
        `${count} already-recorded events linked. No transaction amounts or balances changed.`,
      );
    });
  }
  reparseSaved(): void {
    void this.run(async () => {
      await this.sync.recheckSaved();
      this.snackbar.show(this.sync.notice(), 'INFO', 6000);
    });
  }
  cleanEvidence(): void {
    void this.run(async () => {
      const count = await this.sync.cleanCompletedEvidence();
      this.snackbar.show(
        `${count} dismissed evidence payloads older than 90 days cleared. Deduplication history retained.`,
        'INFO',
        6000,
      );
    });
  }
  private readonly router = inject(Router);
  walletInfo(): ReturnType<typeof walletComparison> {
    const candidate = this.selected();
    const item = candidate?.item;
    const source = this.store
      .paymentSources()
      .find((source) => source.id === this.editor.controls.source.value);
    return item && source
      ? walletComparison(
          item,
          source,
          this.store.transactions(),
          candidate?.transactionId ?? this.editor.controls.existing.value,
        )
      : null;
  }
  updateMatchedBalance(): void {
    const candidate = this.selected();
    if (!candidate || !this.confirmBalance() || this.saving()) return;
    this.saving.set(true);
    void this.run(async () => {
      try {
        await this.sync.adjustMatchedBalance(candidate);
        this.confirmBalance.set(false);
        this.snackbar.show('Wallet balance updated from the verified SMS snapshot.');
      } finally {
        this.saving.set(false);
      }
    });
  }
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
    inject(DestroyRef).onDestroy(() => {
      this.sync.candidates.set([]);
      this.selected.set(null);
      this.related.set([]);
      this.text.reset();
    });
    effect((cleanup) => {
      const dialog = this.readDialog()?.nativeElement;
      if (!dialog) return;
      const releaseScroll = lockDocumentScroll();
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      cleanup(() => {
        releaseScroll();
        if (typeof dialog.close === 'function') dialog.close();
        const trigger = document.getElementById('mark-all-read') as HTMLButtonElement | null;
        if (trigger && !trigger.disabled) trigger.focus();
        else document.getElementById('sms-inbox-title')?.focus();
      });
    });
    effect((cleanup) => {
      const dialog = this.dialog()?.nativeElement;
      if (!dialog || !this.selected()) return;
      const releaseScroll = lockDocumentScroll();
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      queueMicrotask(() => {
        if (dialog.isConnected) dialog.querySelector<HTMLElement>('h2')?.focus();
      });
      cleanup(() => {
        releaseScroll();
        if (typeof dialog.close === 'function') dialog.close();
      });
    });
    effect(() => {
      const available = !this.sync.lock.locked() && this.sync.lock.foreground();
      if (available)
        untracked(() => {
          void this.run(async () => {
            const filters = reviewFilters(await this.sync.loadReviewFilters());
            this.search.set(filters.search);
            this.sourceFilter.set(filters.source);
            this.kind.set(filters.kind);
            this.typeMode.set(filters.mode);
            this.multipleKinds.set(filters.kinds);
            this.multipleInitialized.set(filters.multipleInitialized);
            this.state.set(filters.state);
            this.from.set(filters.from);
            this.to.set(filters.to);
            this.readFilter.set(filters.read);
            this.hideAlreadyAdded.set(filters.hideAlreadyAdded);
            if (this.entryPermissionPending) {
              this.entryPermissionPending = false;
              await this.sync.enterFromReview(this.range());
            }
            await this.sync.refresh();
          });
        });
      else {
        this.selected.set(null);
        this.confirmReadCount.set(null);
        this.sync.candidates.set([]);
        this.text.reset();
      }
    });
  }
  androidBack(event: Event): void {
    if (document.querySelector('app-select-picker dialog[open]')) return;
    if (this.confirmReadCount() !== null) {
      event.preventDefault();
      this.confirmReadCount.set(null);
      return;
    }
    if (this.selected()) {
      event.preventDefault();
      this.closeEditor();
    }
  }
  trapFocus(event: KeyboardEvent): void {
    if (document.querySelector('app-select-picker dialog[open]')) return;
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
      this.snackbar.show(this.error(), 'WARNING');
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
    this.confirmBalance.set(false);
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
            return (
              this.store.transactions().find((entry) => entry.id === candidate.transactionId)
                ?.cardId ?? (ids.length === 1 ? ids[0] : '')
            );
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
    this.related.set([]);
    this.editor.reset();
    this.evidenceTarget.reset();
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
    if (item && !this.editor.controls.source.value) {
      const ids = matchExisting(
        item,
        this.store.cards(),
        this.store.paymentSources(),
        this.store.transactions(),
      ).transactionIds;
      return ids
        .flatMap((id) => this.store.transactions().filter((entry) => entry.id === id))
        .map((entry) => ({
          id: entry.id,
          label: `${entry.transactionDate} · ${entry.merchant ?? entry.type} · ${this.money(entry.amountMinor)} · ${this.store.sourceDetail(entry.cardId)}`,
        }));
    }
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
  chooseExisting(id: string): void {
    const entry = this.store.transactions().find((entry) => entry.id === id);
    if (!entry) return;
    this.editor.controls.source.setValue(entry.cardId);
    this.editor.controls.existing.setValue(entry.id);
  }
  decide(candidate: SmsCandidate, state: 'REJECTED' | 'DEFERRED' | 'IGNORED' | 'PENDING'): void {
    void this.run(async () => {
      await this.sync.decide(candidate, state);
      this.closeEditor();
      this.snackbar.show(
        `Suggestion ${state === 'DEFERRED' ? 'saved for later' : state === 'PENDING' ? 'reopened' : this.label(state).toLowerCase()}.`,
        'INFO',
      );
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
        this.snackbar.show(this.notice());
      } finally {
        this.saving.set(false);
      }
    });
  }
  readonly evidenceTarget = new FormControl('', { nonNullable: true });
  escape(): void {
    if (document.querySelector('app-select-picker dialog[open]')) return;
    if (this.confirmReadCount() !== null) this.confirmReadCount.set(null);
    else this.closeEditor();
  }
  markRead(candidate: SmsCandidate): void {
    void this.run(async () => {
      await this.sync.markRead(candidate.id, !candidate.readAt);
      this.snackbar.show(candidate.readAt ? 'Marked as unread' : 'Marked as read', 'INFO', 5000, {
        label: 'Undo',
        run: () => {
          void this.run(() => this.sync.markRead(candidate.id, !!candidate.readAt));
        },
      });
    });
  }
  swipeReview(candidate: SmsCandidate): void {
    if (
      (candidate.state === 'MATCHED_EXISTING' || candidate.state === 'IMPORTED') &&
      candidate.transactionId
    )
      this.viewExisting(candidate);
    else this.open(candidate);
  }
  swipeRead(candidate: SmsCandidate): void {
    if (this.loading()) return;
    void this.run(async () => {
      const dismissal = await this.sync.dismiss(candidate.id);
      if (!dismissal) return;
      this.snackbar.show('SMS suggestion dismissed', 'INFO', 7000, {
        label: 'Undo',
        run: () => {
          void this.run(() => this.sync.undoDismissal(dismissal));
        },
      });
    });
  }
  requestMarkAllRead(): void {
    if (this.loading() || this.sync.markingRead()) return;
    void this.run(async () => {
      await this.sync.refresh();
      const count = this.sync.unreadTotal();
      if (!count) this.snackbar.show('No unread suggestions.', 'INFO');
      else this.confirmReadCount.set(count);
    });
  }
  confirmMarkAllRead(): void {
    if (this.confirmReadCount() === null || this.sync.markingRead()) return;
    this.confirmReadCount.set(null);
    void this.run(async () => {
      const count = await this.sync.markAllRead();
      this.snackbar.show(
        `${count} saved SMS suggestion${count === 1 ? '' : 's'} marked as read.`,
        'INFO',
      );
    });
  }
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
      this.snackbar.show('Existing payment or EMI match confirmed.');
    });
  }
}
