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

interface NetworkArtwork {
  readonly markup: string;
  readonly fallbackViewBox?: string;
}

const NETWORK_IMAGES: Readonly<Partial<Record<CardNetwork, NetworkArtwork>>> = {
  VISA: { markup: VISA },
  MASTERCARD: { markup: MASTERCARD },
  RUPAY: { markup: RUPAY },
  AMERICAN_EXPRESS: { markup: AMEX, fallbackViewBox: '0 0 1000 997.51703' },
  DISCOVER: { markup: DISCOVER, fallbackViewBox: '0 0 1150 242' },
  DINERS_CLUB: { markup: DINNERS_CLUB },
  JCB: { markup: JCB },
};

function normaliseSvg(artwork: NetworkArtwork): string {
  let markup = artwork.markup
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(\/?)svg:/g, '<$1');
  const rootHasViewBox = /<svg\b[^>]*\bviewBox\s*=/.test(markup);
  const rootAttributes = [
    'preserveAspectRatio="xMidYMid meet"',
    !rootHasViewBox && artwork.fallbackViewBox ? `viewBox="${artwork.fallbackViewBox}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  markup = markup.replace(/<svg\b/, `<svg ${rootAttributes}`);
  return markup;
}

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
  readonly svg = computed(() => {
    const artwork = NETWORK_IMAGES[this.network()] ?? { markup: DEFAULT };
    return this.sanitizer.bypassSecurityTrustHtml(normaliseSvg(artwork));
  });
}
