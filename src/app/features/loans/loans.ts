import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { EmiInstallment, EmiPlan, LoanCommitment } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { AppIcon } from '../../shared/app-icon';
import { ConfirmationDialog } from '../../shared/confirmation-dialog';
import { AppDatePipe } from '../../core/services/date-format.service';

@Component({
  selector: 'app-loans-page',
  imports: [ReactiveFormsModule, AppIcon, AppDatePipe, ConfirmationDialog],
  templateUrl: './loans.html',
  styleUrl: './loans.scss',
})
export class LoansPage {
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  readonly showForm = signal(false);
  readonly selectedEmiId = signal<string | null>(this.route.snapshot.queryParamMap.get('emi'));
  readonly closeEmiCandidate = signal<EmiPlan | null>(null);
  readonly days = Array.from({ length: 28 }, (_, index) => index + 1);
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
  emiTitle(plan: EmiPlan): string {
    return plan.originalMerchant || 'Card purchase';
  }
  installments(planId: string): readonly EmiInstallment[] {
    return this.store
      .emiInstallments()
      .filter((item) => item.emiPlanId === planId)
      .sort((a, b) => a.installmentNumber - b.installmentNumber);
  }
  nextInstallment(planId: string): EmiInstallment | undefined {
    const month = new Date().toISOString().slice(0, 7);
    return this.installments(planId).find(
      (item) => !item.paid && item.statementDate.slice(0, 7) >= month,
    );
  }
  toggleEmi(planId: string): void {
    this.selectedEmiId.set(this.selectedEmiId() === planId ? null : planId);
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
}
