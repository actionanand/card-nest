import { Component, computed, inject, signal } from '@angular/core';
import { CreditCard, LoanCommitment } from '../../core/models/domain';
import {
  daysBetween,
  paymentDueDate,
  previousStatementDate,
  statementDateFor,
  toIsoDate,
} from '../../core/services/billing-cycle';
import { CardNestStore } from '../../core/services/card-nest-store';
import { AppDatePipe } from '../../core/services/date-format.service';
import { indiaTodayDate } from '../../core/services/india-date';
import { formatMoney } from '../../core/services/money';
import { AppIcon } from '../../shared/app-icon';

type PayableOwner = 'ALL' | 'ME' | 'FRIENDS';
interface CardPayable {
  readonly card: CreditCard;
  readonly amountMinor: number;
  readonly dueDate: string;
}
interface LoanPayable {
  readonly loan: LoanCommitment;
  readonly dueDate: string;
  readonly daysUntilDue: number;
}

@Component({
  selector: 'app-payables-page',
  imports: [AppDatePipe, AppIcon],
  templateUrl: './payables.html',
  styleUrl: './payables.scss',
})
export class PayablesPage {
  readonly store = inject(CardNestStore);
  readonly owner = signal<PayableOwner>('ALL');
  readonly cardPayables = computed<readonly CardPayable[]>(() => {
    if (this.owner() === 'FRIENDS') return [];
    return this.store
      .activeCards()
      .map((card) => ({
        card,
        amountMinor: this.store.cardDueAmount(card.id),
        dueDate: this.cardStatementDueDate(card),
      }))
      .filter((payable) => payable.amountMinor > 0)
      .sort((left, right) => left.dueDate.localeCompare(right.dueDate));
  });
  readonly loanPayables = computed<readonly LoanPayable[]>(() =>
    this.store
      .loans()
      .filter(
        (loan) =>
          loan.status === 'ACTIVE' &&
          (this.owner() === 'ALL' ||
            (this.owner() === 'FRIENDS'
              ? loan.forFriendsOrRelatives
              : !loan.forFriendsOrRelatives)),
      )
      .map((loan) => this.upcomingLoanPayable(loan))
      .filter((payable): payable is LoanPayable => payable !== null)
      .sort((left, right) => left.dueDate.localeCompare(right.dueDate)),
  );
  readonly cardTotal = computed(() =>
    this.cardPayables().reduce((total, payable) => total + payable.amountMinor, 0),
  );
  readonly loanTotal = computed(() =>
    this.loanPayables().reduce((total, payable) => total + payable.loan.installmentMinor, 0),
  );
  readonly totalPayable = computed(() => this.cardTotal() + this.loanTotal());
  selectOwner(owner: PayableOwner): void {
    this.owner.set(owner);
  }
  money(value: number): string {
    return formatMoney(value, 'INR');
  }
  dueLabel(days: number): string {
    return days === 0 ? 'Due today' : `Due in ${days} ${days === 1 ? 'day' : 'days'}`;
  }
  private cardStatementDueDate(card: CreditCard): string {
    const reference = indiaTodayDate();
    const nextStatement = statementDateFor(reference, card.statementDay);
    const latestStatement =
      nextStatement.getTime() > reference.getTime()
        ? previousStatementDate(nextStatement, card.statementDay)
        : nextStatement;
    return toIsoDate(paymentDueDate(latestStatement, card));
  }
  private upcomingLoanPayable(loan: LoanCommitment): LoanPayable | null {
    const today = indiaTodayDate();
    for (let offset = 0; offset < 2; offset += 1) {
      const month = new Date(today.getFullYear(), today.getMonth() + offset, 1, 12);
      const due = new Date(
        month.getFullYear(),
        month.getMonth(),
        Math.min(loan.debitDay, new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()),
        12,
      );
      const dueDate = toIsoDate(due);
      const daysUntilDue = daysBetween(today, due);
      if (
        dueDate >= loan.startDate &&
        dueDate <= loan.endDate &&
        daysUntilDue >= 0 &&
        daysUntilDue <= 15
      )
        return { loan, dueDate, daysUntilDue };
    }
    return null;
  }
}
