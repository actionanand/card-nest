import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { AppIcon } from './app-icon';
@Component({
  selector: 'app-platform-tools',
  imports: [RouterLink, AppIcon],
  template: `@if (android) {
    <a
      class="btn btn-primary sms-review-link"
      routerLink="/sms-sync"
      [info]="{ smsReviewEntry: true }"
    >
      <app-icon name="message" /> SMS Review
    </a>
  }`,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    :host:has(.sms-review-link) {
      margin: 0;
    }
    .sms-review-link {
      min-height: 2.75rem;
      padding: 0.6rem 0.8rem;
      max-width: 100%;
      font-size: 0.8rem;
    }
    .sms-review-link:hover {
      background: var(--accent-strong);
    }
    .sms-review-link:active {
      transform: translateY(1px);
    }
    .sms-review-link:focus-visible {
      outline-offset: 3px;
    }
    app-icon {
      width: 1.1rem;
      height: 1.1rem;
    }
  `,
})
export class PlatformTools {
  readonly android = Capacitor.getPlatform() === 'android';
}
