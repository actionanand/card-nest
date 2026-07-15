import { Component, computed, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { RUPEE } from '../../imgData/img';
import { DEBIT_CARD, MEAL_CARD } from '../../imgData/svg';
import { PaymentSourceKind } from '../core/models/domain';

@Component({
  selector: 'app-payment-source-logo',
  template: `@if (kind() === 'CASH') {
      <img [src]="rupee" alt="" />
    } @else {
      <span [innerHTML]="svg()"></span>
    }`,
  styles:
    ':host,span,img{display:block;width:100%;height:100%}img{object-fit:contain}span ::ng-deep svg{display:block;width:100%;height:100%}',
})
export class PaymentSourceLogo {
  private readonly sanitizer = inject(DomSanitizer);
  readonly kind = input.required<PaymentSourceKind>();
  readonly rupee = RUPEE;
  readonly svg = computed(() =>
    this.sanitizer.bypassSecurityTrustHtml(this.kind() === 'MEAL' ? MEAL_CARD : DEBIT_CARD),
  );
}
