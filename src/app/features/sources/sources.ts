import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CardTransaction, PaymentSource, TransactionType } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { SnackbarService } from '../../core/services/snackbar.service';
import { AppIcon } from '../../shared/app-icon';
import { PaymentSourceLogo } from '../../shared/payment-source-logo';
import { AppDatePipe, DateFormatService } from '../../core/services/date-format.service';

type SourceTab = 'ACCOUNTS' | 'ACTIVITY';

interface SourceCycleGroup {
  readonly key: string;
  readonly label: string;
  readonly transactions: readonly CardTransaction[];
  readonly spentMinor: number;
}

@Component({
  selector: 'app-sources-page',
  imports: [RouterLink, AppIcon, PaymentSourceLogo, AppDatePipe],
  templateUrl: './sources.html',
  styleUrl: './sources.scss',
})
export class SourcesPage {
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  private readonly snackbar = inject(SnackbarService);
  private readonly dates = inject(DateFormatService);
  private readonly requestedSourceId = this.route.snapshot.fragment;
  readonly activeTab = signal<SourceTab>(this.requestedSourceId ? 'ACTIVITY' : 'ACCOUNTS');
  readonly selectedSourceId = signal(this.requestedSourceId ?? 'ALL');
  readonly days = Array.from({ length: 28 }, (_, index) => index + 1);
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
    if (selected) return selected.noLimit ? null : (selected.balanceMinor ?? 0);
    const tracked = this.store.paymentSources().filter((source) => !source.noLimit);
    return tracked.length
      ? tracked.reduce((sum, source) => sum + (source.balanceMinor ?? 0), 0)
      : null;
  });

  money(value: number | undefined): string {
    return formatMoney(value ?? 0, 'INR');
  }

  sourceName(sourceId: string): string {
    return (
      this.store.paymentSources().find((source) => source.id === sourceId)?.nickname ?? 'Source'
    );
  }

  categoryName(categoryId: string): string {
    return this.store.categories().find((category) => category.id === categoryId)?.name ?? 'Other';
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

  updateSourceFilter(event: Event): void {
    this.selectedSourceId.set((event.target as HTMLSelectElement).value);
  }

  updateAmount(
    source: PaymentSource,
    event: Event,
    field: 'balanceMinor' | 'loadAmountMinor',
  ): void {
    const value = parseMoneyToMinor((event.target as HTMLInputElement).value);
    if (value === null) return;
    this.store.updatePaymentSource({ ...source, [field]: value });
    this.snackbar.show(`${source.nickname} updated.`);
  }

  updateLoadDay(source: PaymentSource, event: Event): void {
    this.store.updatePaymentSource({
      ...source,
      loadDay: Number((event.target as HTMLSelectElement).value),
    });
    this.snackbar.show(`${source.nickname} load date updated.`);
  }

  toggle(source: PaymentSource, field: 'noLimit' | 'autoLoad'): void {
    this.store.updatePaymentSource({ ...source, [field]: !source[field] });
    this.snackbar.show(`${source.nickname} updated.`);
  }

  transactionLabel(transaction: CardTransaction): string {
    return transaction.merchant || transaction.type.replace('_', ' ');
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
    return Math.max(0, (source.loadAmountMinor ?? 0) - this.monthlyUsed(source));
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
      label: `${this.dates.format(start)} – ${this.dates.format(end)}`,
    };
  }

  private localIso(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')}`;
  }
}
