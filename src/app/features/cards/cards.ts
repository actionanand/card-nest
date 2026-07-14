import { NgOptimizedImage } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { CardNetwork, CreditCard } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import {
  estimatedGracePeriod,
  paymentDueDate,
  statementDateFor,
} from '../../core/services/billing-cycle';
import { formatMoney, parseMoneyToMinor } from '../../core/services/money';

@Component({
  selector: 'app-cards-page',
  imports: [ReactiveFormsModule, NgOptimizedImage],
  templateUrl: './cards.html',
  styleUrl: './cards.scss',
})
export class CardsPage {
  readonly store = inject(CardNestStore);
  private readonly route = inject(ActivatedRoute);
  readonly showForm = signal(this.route.snapshot.queryParamMap.get('add') === 'true');
  readonly showArchived = signal(false);
  readonly visibleCards = computed(() =>
    this.store.cards().filter((card) => (this.showArchived() ? card.archived : !card.archived)),
  );
  readonly networks: readonly { value: CardNetwork; label: string }[] = [
    { value: 'VISA', label: 'Visa' },
    { value: 'MASTERCARD', label: 'Mastercard' },
    { value: 'RUPAY', label: 'RuPay' },
    { value: 'AMERICAN_EXPRESS', label: 'American Express' },
    { value: 'DISCOVER', label: 'Discover' },
    { value: 'JCB', label: 'JCB' },
    { value: 'OTHER', label: 'Other' },
  ];
  readonly form = new FormGroup({
    nickname: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(40)],
    }),
    issuerName: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    lastFourDigits: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^\d{4}$/)],
    }),
    network: new FormControl<CardNetwork>('VISA', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    statementDay: new FormControl(15, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1), Validators.max(31)],
    }),
    daysAfterStatement: new FormControl(20, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1), Validators.max(60)],
    }),
    creditLimit: new FormControl('', { nonNullable: true }),
  });

  money(value: number, currency: string): string {
    return formatMoney(value, currency);
  }
  grace(card: CreditCard): number {
    return estimatedGracePeriod(card);
  }
  due(card: CreditCard): string {
    return paymentDueDate(statementDateFor(new Date(), card.statementDay), card).toLocaleDateString(
      'en-IN',
      { day: 'numeric', month: 'short' },
    );
  }
  utilisation(card: CreditCard): number {
    return card.creditLimitMinor
      ? Math.max(0, Math.round((this.store.cardOutstanding(card.id) / card.creditLimitMinor) * 100))
      : 0;
  }

  save(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const value = this.form.getRawValue();
    const parsedCreditLimit = value.creditLimit ? parseMoneyToMinor(value.creditLimit) : undefined;
    if (parsedCreditLimit === null) {
      this.form.controls.creditLimit.setErrors({ money: true });
      return;
    }
    const creditLimitMinor = parsedCreditLimit;
    const timestamp = new Date().toISOString();
    this.store.addCard({
      id: crypto.randomUUID(),
      nickname: value.nickname.trim(),
      issuerName: value.issuerName.trim(),
      lastFourDigits: value.lastFourDigits,
      network: value.network,
      theme: this.store.cards().length % 2 ? 'teal' : 'indigo',
      statementDay: value.statementDay,
      dueDateMode: 'DAYS_AFTER_STATEMENT',
      daysAfterStatement: value.daysAfterStatement,
      adjustDueDateOnWeekend: true,
      creditLimitMinor,
      currencyCode: 'INR',
      openingBalanceMinor: 0,
      remindToSettle: true,
      annualFeeEnabled: false,
      emergencyPhones: [],
      supportEmails: [],
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.form.reset({
      network: 'VISA',
      statementDay: 15,
      daysAfterStatement: 20,
      nickname: '',
      issuerName: '',
      lastFourDigits: '',
      creditLimit: '',
    });
    this.showForm.set(false);
  }
}
