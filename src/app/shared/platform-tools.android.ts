import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { AppIcon } from './app-icon';
@Component({
  selector: 'app-platform-tools',
  imports: [RouterLink, AppIcon],
  template: `@if (android) {
    <a class="btn sms-review-link" routerLink="/sms-sync" [info]="{ smsReviewEntry: true }">
      <app-icon name="message" /> SMS Review
    </a>
  }`,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    :host:has(.sms-review-link) {
      margin-block: 0 1.25rem;
    }
    .sms-review-link {
      min-height: 2.75rem;
      padding: 0.7rem 1rem;
      max-width: 100%;
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
