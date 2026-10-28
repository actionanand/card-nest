import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  CardTransaction,
  PaymentSource,
  SourceTransfer,
  TransactionType,
} from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { SnackbarService } from '../../core/services/snackbar.service';
import { AppIcon } from '../../shared/app-icon';
import { ProfileModal } from '../../shared/profile-modal';
import { PaymentSourceLogo } from '../../shared/payment-source-logo';
import { AppDatePipe } from '../../core/services/date-format.service';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { recordedTransactionTime } from '../../core/services/transaction-time';
import {
  bankCashTracked,
  isBankOrCash,
  isEnrolledBankAccount,
  transferLabel,
} from '../../core/services/source-balance';
import { SourceMovementDialog, SourceMovementMode } from '../../shared/source-movement-dialog';

interface MovementRequest {
  readonly mode: SourceMovementMode;
  readonly sourceId: string;
  readonly presetFrom?: string;
  readonly presetTo?: string;
  readonly transfer?: SourceTransfer;
}

type SourceTab = 'ACCOUNTS' | 'ACTIVITY';

interface SourceCycleGroup {
  readonly key: string;
  readonly label: string;
  readonly transactions: readonly CardTransaction[];
  readonly spentMinor: number;
}

@Component({
  selector: 'app-sources-page',
  imports: [
    RouterLink,
    ProfileModal,
    AppIcon,
    PaymentSourceLogo,
    AppDatePipe,
    AppSelectPicker,
    ReactiveFormsModule,
    SourceMovementDialog,
  ],
  templateUrl: './sources.html',
  styleUrl: './sources.scss',
})
export class SourcesPage {
  readonly walletOpen = signal(false);
  readonly walletSaving = signal(false);
  openWallet(): void {
    if (this.walletSaving()) return;
    this.walletError.set('');
    this.walletOpen.set(true);
  }
  closeWallet(): void {
    if (!this.walletSaving()) this.walletOpen.set(false);
  }
  readonly walletError = signal('');
  readonly walletForm = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    provider: new FormControl('', { nonNullable: true, validators: Validators.maxLength(80) }),
    plate: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^[A-Za-z0-9 -]{5,16}$/)],
    }),
  });
  async addFastag(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.walletForm.valid || this.walletSaving()) {
      this.walletForm.markAllAsTouched();
      return;
    }
    this.walletError.set('');
    const value = this.walletForm.getRawValue();
    if (!value.name.trim()) {
      this.walletError.set('Enter a wallet name.');
      return;
    }
    this.walletSaving.set(true);
    try {
      await this.store.addWallet({
        id: crypto.randomUUID(),
        nickname: value.name.trim(),
        kind: 'FASTAG',
        institution: value.provider.trim(),
        vehicleNumber: value.plate.replace(/[ -]/g, '').toUpperCase(),
        noLimit: false,
        balanceMinor: 0,
        autoLoad: false,
        archived: false,
      });
      this.walletForm.reset();
      this.walletOpen.set(false);
      this.snackbar.show('FASTag wallet created.');
    } catch (error: unknown) {
      this.walletError.set(error instanceof Error ? error.message : 'Wallet could not be saved.');
      this.snackbar.show(this.walletError(), 'WARNING');
    } finally {
      this.walletSaving.set(false);
    }
  }
  readonly store = inject(CardNestStore);
  readonly archivedBankAccounts = computed(() =>
    this.store.paymentSources().filter((source) => source.kind === 'DEBIT' && source.archived),
  );
  readonly restoringAccounts = signal<ReadonlySet<string>>(new Set());
  readonly movement = signal<MovementRequest | null>(null);
  readonly bankOpen = signal(false);
  readonly bankSaving = signal(false);
  readonly bankError = signal('');
  readonly bankForm = new FormGroup({
    nickname: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    institution: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    lastDigits: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^\d{3,5}$/)],
    }),
  });
  bankToggled(event: Event): void {
    this.bankOpen.set((event.target as HTMLDetailsElement).open);
  }
  async addBankAccount(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.bankForm.valid || this.bankSaving()) {
      this.bankForm.markAllAsTouched();
      return;
    }
    this.bankError.set('');
    this.bankSaving.set(true);
    try {
      const account = await this.store.addBankAccount(this.bankForm.getRawValue());
      this.bankForm.reset();
      this.bankOpen.set(false);
      this.snackbar.show(`${this.store.sourceDetail(account.id)} enrolled.`);
    } catch (error: unknown) {
      this.bankError.set(error instanceof Error ? error.message : 'Account could not be saved.');
      this.snackbar.show(this.bankError(), 'WARNING');
    } finally {
      this.bankSaving.set(false);
    }
  }
  readonly tracking = computed(() => this.store.bankCashTracking());
  isBankOrCash(source: PaymentSource): boolean {
    return isBankOrCash(source);
  }
  isEnrolled(source: PaymentSource): boolean {
    return isEnrolledBankAccount(source);
  }
  tracked(source: PaymentSource): boolean {
    return bankCashTracked(source, this.tracking());
  }
  balanceState(source: PaymentSource): 'TRACKED' | 'NOT_SET' | 'OFF' {
    if (!this.tracking().enabled) return 'OFF';
    return this.tracked(source) ? 'TRACKED' : 'NOT_SET';
  }
  openMovement(request: MovementRequest): void {
    this.movement.set(request);
  }
  firstTrackedBank(excludeId = ''): string {
    return (
      this.store.bankAccounts().find((source) => source.id !== excludeId && this.tracked(source))
        ?.id ?? ''
    );
  }
  async updateBankField(
    source: PaymentSource,
    field: 'nickname' | 'institution' | 'lastDigits',
    event: Event,
  ): Promise<void> {
    const input = event.target as HTMLInputElement;
    const value = input.value.trim();
    if (field === 'institution' && isEnrolledBankAccount(source) && !value) {
      input.setCustomValidity('Enter a bank name.');
      input.reportValidity();
      this.snackbar.show('Enter a bank name.', 'WARNING');
      input.value = source.institution ?? '';
      return;
    }
    if (field === 'lastDigits' && !/^\d{3,5}$/.test(value)) {
      input.setCustomValidity('Enter the last 3 to 5 digits.');
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    if (!value && field !== 'institution') return;
    const saved = await this.persistSource(
      { ...source, [field]: value.slice(0, 80) || undefined },
      `${source.nickname} updated.`,
    );
    if (!saved && input.value.trim() === value)
      input.value = String(
        this.store.paymentSources().find((item) => item.id === source.id)?.[field] ?? '',
      );
  }
  async archiveAccount(source: PaymentSource): Promise<void> {
    await this.persistSource(
      { ...source, archived: true },
      `${source.nickname} archived. Its history is kept.`,
    );
  }
  async restoreAccount(source: PaymentSource): Promise<void> {
    if (this.restoringAccounts().has(source.id)) return;
    this.restoringAccounts.update((ids) => new Set([...ids, source.id]));
    try {
      await this.persistSource(
        { ...source, archived: false },
        `${source.nickname} restored. Its saved balance and history are unchanged.`,
      );
    } finally {
      this.restoringAccounts.update((ids) => new Set([...ids].filter((id) => id !== source.id)));
    }
  }
  readonly visibleTransfers = computed(() =>
    this.store
      .transfers()
      .filter(
        (transfer) =>
          this.selectedSourceId() === 'ALL' ||
          transfer.fromSourceId === this.selectedSourceId() ||
          transfer.toSourceId === this.selectedSourceId(),
      ),
  );
  readonly visibleAdjustments = computed(() =>
    this.store
      .balanceAdjustments()
      .filter(
        (adjustment) =>
          this.selectedSourceId() === 'ALL' || adjustment.sourceId === this.selectedSourceId(),
      )
      .slice(0, 20),
  );
  transferTitle(transfer: SourceTransfer): string {
    const to = transfer.toSourceId
      ? this.store.sourceDetail(transfer.toSourceId)
      : transfer.cardId
        ? this.store.sourceDetail(transfer.cardId)
        : 'Loan repayment';
    return `${transferLabel(transfer.kind)} · ${this.store.sourceDetail(transfer.fromSourceId)} → ${to}`;
  }
  transferIncoming(transfer: SourceTransfer): boolean {
    return this.selectedSourceId() !== 'ALL' && transfer.toSourceId === this.selectedSourceId();
  }
  editTransfer(transfer: SourceTransfer): void {
    this.openMovement({ mode: 'TRANSFER', sourceId: transfer.fromSourceId, transfer });
  }
  private readonly route = inject(ActivatedRoute);
  private readonly snackbar = inject(SnackbarService);
  private readonly requestedSourceId = this.route.snapshot.fragment;
  readonly activeTab = signal<SourceTab>(this.requestedSourceId ? 'ACTIVITY' : 'ACCOUNTS');
  readonly selectedSourceId = signal(this.requestedSourceId ?? 'ALL');
  readonly days = Array.from({ length: 28 }, (_, index) => index + 1);
  readonly loadDayOptions: readonly AppSelectOption[] = this.days.map((day) => ({
    value: String(day),
    label: `Day ${day}`,
  }));
  readonly sourceOptions = computed<readonly AppSelectOption[]>(() => [
    { value: 'ALL', label: 'All cash, bank and meal sources' },
    ...this.store.activePaymentSources().map((source) => ({
      value: source.id,
      label: source.nickname,
      detail: [source.lastDigits, source.institution].filter(Boolean).join(' · '),
    })),
  ]);
  readonly selectedSource = computed(() =>
    this.store.paymentSources().find((source) => source.id === this.selectedSourceId()),
  );
  readonly sourceTransactions = computed(() => {
    const sourceIds = new Set(this.store.paymentSources().map((source) => source.id));
    return this.store.transactions().filter((transaction) => sourceIds.has(transaction.cardId));
  });
  readonly visibleTransactions = computed(() =>
    this.sourceTransactions()
      .filter(
        (transaction) =>
          this.selectedSourceId() === 'ALL' || transaction.cardId === this.selectedSourceId(),
      )
      .sort(
        (left, right) =>
          right.transactionDate.localeCompare(left.transactionDate) ||
          (right.transactionTime ?? '').localeCompare(left.transactionTime ?? '') ||
          right.createdAt.localeCompare(left.createdAt),
      ),
  );
  readonly currentCycle = computed(() => this.cycleFor(new Date().toISOString().slice(0, 10)));
  readonly currentCycleTransactions = computed(() => {
    const period = this.currentCycle();
    return this.visibleTransactions().filter(
      (transaction) =>
        transaction.transactionDate >= period.startIso &&
        transaction.transactionDate <= period.endIso,
    );
  });
  readonly transactionGroups = computed<readonly SourceCycleGroup[]>(() => {
    const groups = new Map<string, CardTransaction[]>();
    for (const transaction of this.visibleTransactions()) {
      const cycle = this.cycleFor(transaction.transactionDate);
      groups.set(cycle.startIso, [...(groups.get(cycle.startIso) ?? []), transaction]);
    }
    return [...groups.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([key, transactions]) => {
        const cycle = this.cycleFor(key);
        return {
          key,
          label: cycle.label,
          transactions,
          spentMinor: transactions
            .filter((transaction) => !this.isCredit(transaction.type))
            .reduce((sum, transaction) => sum + transaction.amountMinor, 0),
        };
      });
  });
  readonly spentMinor = computed(() =>
    this.currentCycleTransactions()
      .filter((transaction) => !this.isCredit(transaction.type))
      .reduce((sum, transaction) => sum + transaction.amountMinor, 0),
  );
  readonly creditsMinor = computed(() =>
    this.currentCycleTransactions()
      .filter((transaction) => this.isCredit(transaction.type))
      .reduce((sum, transaction) => sum + transaction.amountMinor, 0),
  );
  readonly remainingMinor = computed(() => {
    const selected = this.selectedSource();
    const funds = (source: PaymentSource) =>
      isBankOrCash(source) ? this.tracked(source) : !source.noLimit;
    if (selected) return funds(selected) ? (selected.balanceMinor ?? 0) : null;
    const tracked = this.store.paymentSources().filter(funds);
    return tracked.length
      ? tracked.reduce((sum, source) => sum + (source.balanceMinor ?? 0), 0)
      : null;
  });

  money(value: number | undefined): string {
    return formatMoney(value ?? 0, 'INR');
  }

  sourceName(sourceId: string): string {
    const source = this.store.paymentSources().find((item) => item.id === sourceId);
    return source
      ? `${source.nickname}${source.lastDigits ? ` ${source.lastDigits}` : ''}`
      : 'Source';
  }

  categoryName(categoryId: string): string {
    return this.store.categories().find((category) => category.id === categoryId)?.name ?? 'Other';
  }

  recordedTime(transaction: CardTransaction): string {
    return recordedTransactionTime(transaction.transactionTime, true);
  }

  isCredit(type: TransactionType): boolean {
    return ['PAYMENT', 'REFUND', 'CASHBACK', 'CREDIT'].includes(type);
  }

  selectTab(tab: SourceTab): void {
    this.activeTab.set(tab);
  }

  showSourceActivity(sourceId: string): void {
    this.selectedSourceId.set(sourceId);
    this.activeTab.set('ACTIVITY');
    queueMicrotask(() => document.querySelector<HTMLElement>('#source-activity')?.focus());
  }

  updateSourceFilter(value: string): void {
    this.selectedSourceId.set(value);
  }

  async updateAmount(
    source: PaymentSource,
    event: Event,
    field: 'balanceMinor' | 'loadAmountMinor',
  ): Promise<void> {
    const value = parseMoneyToMinor((event.target as HTMLInputElement).value);
    if (value === null) return;
    await this.persistSource({ ...source, [field]: value }, `${source.nickname} updated.`);
  }

  async updateLoadDay(source: PaymentSource, value: string): Promise<void> {
    await this.persistSource(
      { ...source, loadDay: Number(value) },
      `${source.nickname} load date updated.`,
    );
  }

  sanitizeLastDigits(event: Event): void {
    const input = event.target as HTMLInputElement;
    input.value = input.value.replace(/\D/g, '').slice(0, 4);
    input.setCustomValidity(
      input.value.length === 0 || input.value.length === 4 ? '' : 'Enter exactly 4 digits.',
    );
  }

  async updateLastDigits(source: PaymentSource, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    this.sanitizeLastDigits(event);
    if (!input.checkValidity()) {
      input.reportValidity();
      return;
    }
    await this.persistSource(
      { ...source, lastDigits: input.value || undefined },
      `${source.nickname} last four digits updated.`,
    );
  }

  async toggle(source: PaymentSource, field: 'noLimit' | 'autoLoad'): Promise<void> {
    await this.persistSource({ ...source, [field]: !source[field] }, `${source.nickname} updated.`);
  }
  private async persistSource(source: PaymentSource, message: string): Promise<boolean> {
    try {
      await this.store.updatePaymentSource(source);
      this.snackbar.show(message);
      return true;
    } catch (error: unknown) {
      this.snackbar.show(
        error instanceof Error ? error.message : 'The account could not be saved. Please retry.',
        'WARNING',
      );
      return false;
    }
  }

  transactionLabel(transaction: CardTransaction): string {
    const label = transaction.merchant || transaction.type.replace('_', ' ');
    return transaction.bankName ? `${transaction.bankName} · ${label}` : label;
  }

  monthlyUsed(source: PaymentSource): number {
    return this.store
      .transactions()
      .filter(
        (transaction) =>
          transaction.cardId === source.id &&
          transaction.transactionDate >= this.currentCycle().startIso &&
          transaction.transactionDate <= this.currentCycle().endIso &&
          !this.isCredit(transaction.type),
      )
      .reduce((sum, transaction) => sum + transaction.amountMinor, 0);
  }

  monthlyRemaining(source: PaymentSource): number {
    const loads = this.currentCycleTransactions()
      .filter((t) => t.cardId === source.id && this.isCredit(t.type))
      .reduce((sum, t) => sum + t.amountMinor, 0);
    return loads - this.monthlyUsed(source);
  }

  private cycleFor(dateIso: string): { startIso: string; endIso: string; label: string } {
    const date = new Date(`${dateIso}T12:00:00`);
    const cycleDay = this.store.budgetCycleStartDay();
    const start = new Date(date.getFullYear(), date.getMonth(), cycleDay, 12);
    if (date.getDate() < cycleDay) start.setMonth(start.getMonth() - 1);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    end.setDate(end.getDate() - 1);
    const startIso = this.localIso(start);
    const endIso = this.localIso(end);
    return {
      startIso,
      endIso,
      label: `${this.cycleDate(start)} – ${this.cycleDate(end)}`,
    };
  }

  private localIso(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')}`;
  }

  private cycleDate(date: Date): string {
    return `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(
      2,
      '0',
    )}-${date.getFullYear()}`;
  }
}
