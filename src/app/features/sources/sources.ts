import { Component, inject } from '@angular/core';
import { PaymentSource } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { PaymentSourceLogo } from '../../shared/payment-source-logo';

@Component({
  selector: 'app-sources-page',
  imports: [PaymentSourceLogo],
  templateUrl: './sources.html',
  styleUrl: './sources.scss',
})
export class SourcesPage {
  readonly store = inject(CardNestStore);
  readonly days = Array.from({ length: 28 }, (_, index) => index + 1);
  money(value: number | undefined): string {
    return formatMoney(value ?? 0, 'INR');
  }
  updateAmount(
    source: PaymentSource,
    event: Event,
    field: 'balanceMinor' | 'loadAmountMinor',
  ): void {
    const value = parseMoneyToMinor((event.target as HTMLInputElement).value);
    if (value === null) return;
    this.store.updatePaymentSource({ ...source, [field]: value });
  }
  updateLoadDay(source: PaymentSource, event: Event): void {
    this.store.updatePaymentSource({
      ...source,
      loadDay: Number((event.target as HTMLSelectElement).value),
    });
  }
  toggle(source: PaymentSource, field: 'noLimit' | 'autoLoad'): void {
    this.store.updatePaymentSource({ ...source, [field]: !source[field] });
  }
}
