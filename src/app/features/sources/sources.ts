import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CardTransaction, PaymentSource, TransactionType } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { SnackbarService } from '../../core/services/snackbar.service';
import { AppIcon } from '../../shared/app-icon';
import { PaymentSourceLogo } from '../../shared/payment-source-logo';

type SourceTab = 'ACCOUNTS' | 'ACTIVITY';

@Component({
  selector: 'app-sources-page',
  imports: [RouterLink, AppIcon, PaymentSourceLogo],
  templateUrl: './sources.html',
  styleUrl: './sources.scss',
})
export class SourcesPage {
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  private readonly snackbar = inject(SnackbarService);
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
    this.sourceTransactions().filter(
      (transaction) =>
        this.selectedSourceId() === 'ALL' || transaction.cardId === this.selectedSourceId(),
    ),
  );
  readonly spentMinor = computed(() =>
    this.visibleTransactions()
      .filter((transaction) => !this.isCredit(transaction.type))
      .reduce((sum, transaction) => sum + transaction.amountMinor, 0),
  );
  readonly creditsMinor = computed(() =>
    this.visibleTransactions()
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
}
