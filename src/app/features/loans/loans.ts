import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { LoanCommitment } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';
import { AppIcon } from '../../shared/app-icon';

@Component({
  selector: 'app-loans-page',
  imports: [ReactiveFormsModule, AppIcon],
  templateUrl: './loans.html',
  styleUrl: './loans.scss',
})
export class LoansPage {
  readonly store = inject(CardNestStore);
  readonly showForm = signal(false);
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
