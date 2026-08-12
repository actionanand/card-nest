import { Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { EmiInstallment, EmiPlan, LoanCommitment, RecurringRule } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { AppIcon } from '../../shared/app-icon';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
import { AppDatePipe } from '../../core/services/date-format.service';
import { SnackbarService } from '../../core/services/snackbar.service';
import { AppSelectOption, AppSelectPicker } from '../../shared/app-select-picker';
import { AppDatePicker } from '../../shared/app-date-picker';

type CommitmentFilter = 'ACTIVE' | 'INACTIVE' | 'ALL';

@Component({
  selector: 'app-loans-page',
  imports: [
    ReactiveFormsModule,
    AppIcon,
    AppDatePipe,
    ConfirmationDialog,
    AppSelectPicker,
    AppDatePicker,
  ],
  templateUrl: './loans.html',
  styleUrl: './loans.scss',
})
export class LoansPage {
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  private readonly snackbar = inject(SnackbarService);
  readonly showForm = signal(false);
  readonly commitmentFilter = signal<CommitmentFilter>('ACTIVE');
  readonly selectedEmiId = signal<string | null>(this.route.snapshot.queryParamMap.get('emi'));
  readonly selectedRepeatId = signal<string | null>(
    this.route.snapshot.queryParamMap.get('repeat'),
  );
  readonly editingRepeatId = signal<string | null>(null);
  readonly repeatAmount = signal('');
  readonly repeatAmountError = signal<string | null>(null);
  readonly closeEmiCandidate = signal<EmiPlan | null>(null);
  readonly terminateRepeatCandidate = signal<RecurringRule | null>(null);
  readonly cancelLoanCandidate = signal<LoanCommitment | null>(null);
  readonly visibleRepeats = computed(() =>
    this.store.recurringRules().filter((rule) => this.matchesFilter(rule.status === 'ACTIVE')),
  );
  readonly visibleEmiPlans = computed(() =>
    this.store.emiPlans().filter((plan) => this.matchesFilter(plan.status === 'ACTIVE')),
  );
  readonly visibleLoans = computed(() =>
    this.store.loans().filter((loan) => this.matchesFilter(loan.status === 'ACTIVE')),
  );
  readonly currentMonthKey = new Date().toISOString().slice(0, 7);
  readonly currentMonthLabel = new Date().toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
  readonly recurringDueThisMonth = computed(() =>
    this.store
      .recurringRules()
      .filter((rule) => rule.status === 'ACTIVE')
      .reduce((total, rule) => total + this.recurringDueForMonth(rule), 0),
  );
  readonly emiDueThisMonth = computed(() =>
    this.store
      .emiPlans()
      .filter((plan) => plan.status === 'ACTIVE')
      .reduce(
        (total, plan) =>
          total +
          this.installments(plan.id)
            .filter(
              (installment) =>
                !installment.paid && installment.statementDate.startsWith(this.currentMonthKey),
            )
            .reduce((sum, installment) => sum + installment.totalMinor, 0),
        0,
      ),
  );
  readonly loanDueThisMonth = computed(() =>
    this.store
      .loans()
      .filter((loan) => loan.status === 'ACTIVE' && this.loanRunsInCurrentMonth(loan))
      .reduce((total, loan) => total + loan.installmentMinor, 0),
  );
  readonly totalDueThisMonth = computed(
    () => this.recurringDueThisMonth() + this.emiDueThisMonth() + this.loanDueThisMonth(),
  );
  readonly days = Array.from({ length: 28 }, (_, index) => index + 1);
  readonly filterOptions: readonly AppSelectOption[] = [
    { value: 'ACTIVE', label: 'Active' },
    { value: 'INACTIVE', label: 'Completed / stopped' },
    { value: 'ALL', label: 'All commitments' },
  ];
  readonly debitDayOptions: readonly AppSelectOption[] = this.days.map((day) => ({
    value: String(day),
    label: `Day ${day}`,
  }));
  readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    lender: new FormControl('', { nonNullable: true }),
    principal: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    installment: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    debitDay: new FormControl(5, { nonNullable: true }),
    startDate: new FormControl(new Date().toISOString().slice(0, 10), {
      nonNullable: true,
      validators: [Validators.required],
    }),
    endDate: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    notes: new FormControl('', { nonNullable: true }),
  });
  money(value: number): string {
    return formatMoney(value, 'INR');
  }
  updateCommitmentFilter(value: string): void {
    this.commitmentFilter.set(value as CommitmentFilter);
  }
  setDebitDay(value: string): void {
    this.form.controls.debitDay.setValue(Number(value));
  }
  setStartDate(value: string): void {
    this.form.controls.startDate.setValue(value);
  }
  setEndDate(value: string): void {
    this.form.controls.endDate.setValue(value);
  }
  emiTitle(plan: EmiPlan): string {
    return plan.originalMerchant || 'Card purchase';
  }
  installments(planId: string): readonly EmiInstallment[] {
    return this.store
      .emiInstallments()
      .filter((item) => item.emiPlanId === planId)
      .sort((a, b) => a.installmentNumber - b.installmentNumber);
  }
  emiExtra(planId: string, originalMinor: number): number {
    const total = this.installments(planId).reduce((sum, item) => sum + item.totalMinor, 0);
    return Math.max(0, total - originalMinor);
  }
  nextInstallment(planId: string): EmiInstallment | undefined {
    const month = new Date().toISOString().slice(0, 7);
    return this.installments(planId).find(
      (item) => !item.paid && item.statementDate.slice(0, 7) >= month,
    );
  }
  repeatDebitDate(rule: RecurringRule): string | null {
    return rule.status === 'ACTIVE' ? (rule.nextOccurrenceDate ?? null) : null;
  }
  emiDebitDate(planId: string): string | null {
    return this.nextInstallment(planId)?.statementDate ?? null;
  }
  loanDebitDate(loan: LoanCommitment): string | null {
    if (loan.status !== 'ACTIVE') return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let offset = 0; offset < 24; offset += 1) {
      const month = new Date(today.getFullYear(), today.getMonth() + offset, 1, 12);
      const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
      const candidate = new Date(
        month.getFullYear(),
        month.getMonth(),
        Math.min(loan.debitDay, lastDay),
        12,
      );
      const iso = this.localIso(candidate);
      if (candidate >= today && iso >= loan.startDate && iso <= loan.endDate) return iso;
    }
    return null;
  }
  toggleEmi(planId: string): void {
    this.selectedEmiId.set(this.selectedEmiId() === planId ? null : planId);
  }
  repeatTransactions(ruleId: string) {
    return this.store
      .transactions()
      .filter((transaction) => transaction.recurringRuleId === ruleId)
      .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));
  }
  repeatProgress(rule: RecurringRule): string {
    return `${this.repeatTransactions(rule.id).length}/${rule.occurrenceLimit ?? '∞'}`;
  }
  repeatRemaining(rule: RecurringRule): string {
    if (!rule.occurrenceLimit) return rule.status === 'ACTIVE' ? 'No fixed end' : 'Ended';
    return `${Math.max(0, rule.occurrenceLimit - this.repeatTransactions(rule.id).length)} remaining`;
  }
  toggleRepeat(ruleId: string): void {
    this.selectedRepeatId.set(this.selectedRepeatId() === ruleId ? null : ruleId);
  }
  editFutureRepeat(rule: RecurringRule): void {
    this.editingRepeatId.set(rule.id);
    this.repeatAmount.set(String(rule.amountMinor / 100));
    this.repeatAmountError.set(null);
  }
  saveFutureRepeat(rule: RecurringRule): void {
    const amountMinor = parseMoneyToMinor(this.repeatAmount());
    if (!amountMinor || amountMinor <= 0) {
      this.repeatAmountError.set('Enter a valid future transaction amount.');
      return;
    }
    this.store.updateRecurringRule(rule.id, amountMinor);
    this.editingRepeatId.set(null);
    this.repeatAmountError.set(null);
    this.snackbar.show('Future recurring transactions will use the new amount.');
  }
  requestTerminateRepeat(rule: RecurringRule): void {
    this.terminateRepeatCandidate.set(rule);
  }
  confirmTerminateRepeat(): void {
    const rule = this.terminateRepeatCandidate();
    if (!rule) return;
    this.store.terminateRecurringRule(rule.id);
    this.terminateRepeatCandidate.set(null);
    this.snackbar.show('Upcoming recurring transactions were stopped.', 'INFO');
  }
  requestCancelLoan(loan: LoanCommitment): void {
    this.cancelLoanCandidate.set(loan);
  }
  confirmCancelLoan(): void {
    const loan = this.cancelLoanCandidate();
    if (!loan) return;
    this.store.cancelLoan(loan.id);
    this.cancelLoanCandidate.set(null);
    this.snackbar.show('Upcoming loan installments were stopped.', 'INFO');
  }
  requestCloseEmi(plan: EmiPlan): void {
    this.closeEmiCandidate.set(plan);
  }
  confirmCloseEmi(): void {
    const plan = this.closeEmiCandidate();
    if (!plan) return;
    this.store.closeEmiPlan(plan.id);
    this.closeEmiCandidate.set(null);
  }
  save(): void {
    this.form.markAllAsTouched();
    const principalMinor = parseMoneyToMinor(this.form.controls.principal.value);
    const installmentMinor = parseMoneyToMinor(this.form.controls.installment.value);
    if (!principalMinor) this.form.controls.principal.setErrors({ money: true });
    if (!installmentMinor) this.form.controls.installment.setErrors({ money: true });
    if (this.form.invalid || !principalMinor || !installmentMinor) return;
    const value = this.form.getRawValue();
    const loan: LoanCommitment = {
      id: crypto.randomUUID(),
      name: value.name.trim(),
      lender: value.lender.trim() || undefined,
      principalMinor,
      installmentMinor,
      debitDay: value.debitDay,
      startDate: value.startDate,
      endDate: value.endDate,
      status: 'ACTIVE',
      notes: value.notes.trim() || undefined,
    };
    this.store.addLoan(loan);
    this.showForm.set(false);
    this.form.reset({
      name: '',
      lender: '',
      principal: '',
      installment: '',
      debitDay: 5,
      startDate: new Date().toISOString().slice(0, 10),
      endDate: '',
      notes: '',
    });
  }

  private matchesFilter(active: boolean): boolean {
    if (this.commitmentFilter() === 'ALL') return true;
    return this.commitmentFilter() === 'ACTIVE' ? active : !active;
  }

  private recurringDueForMonth(rule: RecurringRule): number {
    const generated = this.repeatTransactions(rule.id).filter((transaction) =>
      transaction.transactionDate.startsWith(this.currentMonthKey),
    );
    const generatedTotal = generated.reduce(
      (total, transaction) => total + transaction.amountMinor,
      0,
    );
    const nextIsThisMonth = rule.nextOccurrenceDate?.startsWith(this.currentMonthKey) ?? false;
    const nextAlreadyGenerated = generated.some(
      (transaction) => transaction.generatedOccurrenceDate === rule.nextOccurrenceDate,
    );
    return generatedTotal + (nextIsThisMonth && !nextAlreadyGenerated ? rule.amountMinor : 0);
  }

  private loanRunsInCurrentMonth(loan: LoanCommitment): boolean {
    const monthStart = `${this.currentMonthKey}-01`;
    const [year, month] = this.currentMonthKey.split('-').map(Number);
    const monthEnd = this.localIso(new Date(year, month, 0, 12));
    return loan.startDate <= monthEnd && loan.endDate >= monthStart;
  }

  private localIso(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')}`;
  }
}
