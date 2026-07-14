import { Component, computed, inject } from '@angular/core';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney } from '../../core/services/money';

@Component({ selector: 'app-reports-page', templateUrl: './reports.html', styleUrl: './reports.scss' })
export class ReportsPage {
  readonly store = inject(CardNestStore);
  readonly byCategory = computed(() => {
    const expenses = this.store.transactions().filter(item => item.type === 'PURCHASE' || item.type === 'FEE' || item.type === 'INTEREST');
    const total = expenses.reduce((sum, item) => sum + item.amountMinor, 0);
    return this.store.categories().map(category => {
      const amount = expenses.filter(item => item.categoryId === category.id).reduce((sum, item) => sum + item.amountMinor, 0);
      return { ...category, amount, percent: total ? Math.round(amount / total * 100) : 0 };
    }).filter(item => item.amount > 0).sort((a, b) => b.amount - a.amount);
  });
  readonly maxCategory = computed(() => Math.max(...this.byCategory().map(item => item.amount), 1));
  money(value: number): string { return formatMoney(value, 'INR'); }
}
