import { Component, computed, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import {
  AMEX,
  DEFAULT,
  DINNERS_CLUB,
  DISCOVER,
  JCB,
  MASTERCARD,
  RUPAY,
  VISA,
} from '../../imgData/svg';
import { CardNetwork } from '../core/models/domain';

const NETWORK_IMAGES: Readonly<Partial<Record<CardNetwork, string>>> = {
  VISA,
  MASTERCARD,
  RUPAY,
  AMERICAN_EXPRESS: AMEX,
  DISCOVER,
  DINERS_CLUB: DINNERS_CLUB,
  JCB,
};

@Component({
  selector: 'app-card-network-logo',
  template:
    '<span class="logo" [innerHTML]="svg()" aria-hidden="true"></span><span class="sr-only">{{ label() }}</span>',
  styles: `
    :host {
      display: inline-grid;
      place-items: center;
      min-width: 0;
    }
    .logo {
      display: grid;
      width: 100%;
      height: 100%;
      place-items: center;
    }
    .logo ::ng-deep svg {
      display: block;
      width: 100%;
      height: 100%;
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
  `,
})
export class CardNetworkLogo {
  private readonly sanitizer = inject(DomSanitizer);
  readonly network = input.required<CardNetwork>();
  readonly label = computed(() => this.network().replaceAll('_', ' '));
  readonly svg = computed(() =>
    this.sanitizer.bypassSecurityTrustHtml(NETWORK_IMAGES[this.network()] ?? DEFAULT),
  );
}
