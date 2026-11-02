import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  CardTransaction,
  PaymentSource,
  SourceTransfer,
  TransactionType,
} from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { DeviceCalendarClock } from '../../core/services/device-date';
import { displayBankAccountSuffix } from '../../core/services/bank-account-identifier';
import {
  formatMoney,
  parseMoneyToMinor,
  spendingContribution,
  transactionEffect,
} from '../../core/services/money';
import { SnackbarService } from '../../core/services/snackbar.service';
import { AppIcon } from '../../shared/app-icon';
import { PaymentSourceLogo } from '../../shared/payment-source-logo';
import { AppDatePipe } from '../../core/services/date-format.service';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';
import { recordedTransactionTime } from '../../core/services/transaction-time';
import {
  bankCashTracked,
  bankTrackingEnabled,
  cashTrackingEnabled,
  hasWalletBaseline,
  isBankOrCash,
  sourceBalanceTrackingEnabled,
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
type BalanceSummaryStatus = 'OFF' | 'NONE' | 'INCOMPLETE' | 'KNOWN';

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
    AppIcon,
    PaymentSourceLogo,
    AppDatePipe,
    AppSelectPicker,
    SourceMovementDialog,
  ],
  templateUrl: './sources.html',
  styleUrl: './sources.scss',
})
export class SourcesPage {
  private readonly calendarClock = inject(DeviceCalendarClock);
  readonly store = inject(CardNestStore);
  readonly movement = signal<MovementRequest | null>(null);
  readonly tracking = computed(() => this.store.bankCashTracking());
  readonly nonBankSources = computed(() =>
    this.store
      .activePaymentSources()
      .filter((source) => source.kind !== 'DEBIT' && source.kind !== 'FASTAG'),
  );
  readonly bankBalanceSummary = computed(() => {
    if (!bankTrackingEnabled(this.tracking())) return { status: 'OFF' as BalanceSummaryStatus };
    const sources = this.store.bankAccounts();
    if (!sources.length) return { status: 'NONE' as BalanceSummaryStatus };
    const known = sources.filter((source) => this.tracked(source));
    const totalMinor = known.reduce((sum, source) => sum + (source.balanceMinor ?? 0), 0);
    if (!Number.isSafeInteger(totalMinor)) return { status: 'INCOMPLETE' as BalanceSummaryStatus };
    if (!known.length) return { status: 'INCOMPLETE' as BalanceSummaryStatus };
    return known.length === sources.length
      ? { status: 'KNOWN' as BalanceSummaryStatus, totalMinor }
      : { status: 'INCOMPLETE' as BalanceSummaryStatus, totalMinor };
  });
  readonly liquidBalanceSummary = computed(() => {
    const tracking = this.tracking();
    if (!bankTrackingEnabled(tracking) && !cashTrackingEnabled(tracking))
      return { status: 'OFF' as BalanceSummaryStatus };
    const sources = this.store
      .paymentSources()
      .filter(
        (source) => isBankOrCash(source) && !source.archived && this.trackingEnabledFor(source),
      );
    if (!sources.length) return { status: 'NONE' as BalanceSummaryStatus };
    if (!sources.every((source) => this.tracked(source)))
      return { status: 'INCOMPLETE' as BalanceSummaryStatus };
    const totalMinor = sources.reduce((sum, source) => sum + (source.balanceMinor ?? 0), 0);
    return Number.isSafeInteger(totalMinor)
      ? { status: 'KNOWN' as BalanceSummaryStatus, totalMinor }
      : { status: 'INCOMPLETE' as BalanceSummaryStatus };
  });
  isBankOrCash(source: PaymentSource): boolean {
    return isBankOrCash(source);
  }
  tracked(source: PaymentSource): boolean {
    return bankCashTracked(source, this.tracking());
  }
  trackingEnabledFor(source: PaymentSource): boolean {
    return sourceBalanceTrackingEnabled(source, this.tracking());
  }
  balanceState(source: PaymentSource): 'TRACKED' | 'NOT_SET' | 'OFF' {
    if (!this.trackingEnabledFor(source)) return 'OFF';
    return this.tracked(source) ? 'TRACKED' : 'NOT_SET';
  }
  bankAccountBalanceLabel(source: PaymentSource): string {
    if (!bankTrackingEnabled(this.tracking())) return 'Not tracked';
    return this.tracked(source) ? this.money(source.balanceMinor) : 'Balance not set';
  }
  liquidBalanceLabel(): string {
    const summary = this.liquidBalanceSummary();
    if (summary.status === 'OFF') return 'Balance tracking off';
    if (summary.status === 'NONE') return 'No active Bank/Cash accounts';
    if (summary.status === 'INCOMPLETE') return 'Incomplete · one or more balances not set';
    return this.money(summary.totalMinor ?? 0);
  }
  liquidBalanceTitle(): string {
    const bank = bankTrackingEnabled(this.tracking());
    const cash = cashTrackingEnabled(this.tracking());
    return bank && cash ? 'Bank + Cash' : bank ? 'Bank' : 'Cash';
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
      detail: [
        source.kind === 'DEBIT' ? displayBankAccountSuffix(source.lastDigits) : source.lastDigits,
        source.institution,
      ]
        .filter(Boolean)
        .join(' · '),
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
  readonly currentCycle = computed(() => {
    return this.cycleFor(this.calendarClock.calendar().dateIso);
  });
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
    if (selected)
      return isBankOrCash(selected) && !this.trackingEnabledFor(selected)
        ? null
        : funds(selected)
          ? (selected.balanceMinor ?? 0)
          : null;
    const activeSources = this.store.activePaymentSources();
    const activeBankCash = activeSources.filter(isBankOrCash);
    if (activeBankCash.some((source) => this.trackingEnabledFor(source) && !this.tracked(source)))
      return null;
    const tracked = activeSources.filter(funds);
    return tracked.length
      ? tracked.reduce((sum, source) => sum + (source.balanceMinor ?? 0), 0)
      : null;
  });
  remainingLabel(): string {
    const selected = this.selectedSource();
    if (selected && isBankOrCash(selected)) {
      if (!this.trackingEnabledFor(selected)) return 'Balance tracking off';
      if (!this.tracked(selected)) return 'Balance not set';
    }
    if (
      !selected &&
      (bankTrackingEnabled(this.tracking()) || cashTrackingEnabled(this.tracking()))
    ) {
      const banks = this.store.activePaymentSources().filter(isBankOrCash);
      if (banks.some((source) => this.trackingEnabledFor(source) && !this.tracked(source)))
        return 'Incomplete · one or more balances not set';
    }
    const remaining = this.remainingMinor();
    return remaining === null ? 'Not tracked' : this.money(remaining);
  }

  money(value: number | undefined): string {
    return formatMoney(value ?? 0, 'INR');
  }

  sourceName(sourceId: string): string {
    const source = this.store.paymentSources().find((item) => item.id === sourceId);
    return source
      ? `${source.nickname}${source.lastDigits ? ` ${source.kind === 'DEBIT' ? displayBankAccountSuffix(source.lastDigits) : source.lastDigits}` : ''}`
      : 'Source';
  }

  accountIdentifier(source: PaymentSource): string {
    return displayBankAccountSuffix(source.lastDigits);
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
    return this.pluxeeCycleTransactions(source).reduce(
      (sum, transaction) => sum + spendingContribution(transaction),
      0,
    );
  }

  monthlyRemaining(source: PaymentSource): number {
    return this.pluxeeCycleTransactions(source).reduce(
      (sum, transaction) => sum - transactionEffect(transaction),
      0,
    );
  }

  topupsThisCycle(source: PaymentSource): number {
    return this.pluxeeCycleTransactions(source)
      .filter((transaction) => transaction.type === 'CREDIT')
      .reduce((sum, transaction) => sum - transactionEffect(transaction), 0);
  }

  pluxeeAvailableBalance(source: PaymentSource): string {
    if (source.noLimit) return 'Not tracked';
    return source.balanceMinor === undefined ? 'Balance not set' : this.money(source.balanceMinor);
  }

  canAddMoney(source: PaymentSource): boolean {
    return hasWalletBaseline(source);
  }

  private pluxeeCycleTransactions(source: PaymentSource): readonly CardTransaction[] {
    if (source.kind !== 'MEAL') return [];
    const period = this.currentCycle();
    return this.store
      .transactions()
      .filter(
        (transaction) =>
          transaction.cardId === source.id &&
          transaction.transactionDate >= period.startIso &&
          transaction.transactionDate <= period.endIso &&
          !(
            transaction.type === 'ADJUSTMENT' &&
            transaction.adjustmentPurpose === 'BALANCE_RECONCILIATION'
          ),
      );
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
