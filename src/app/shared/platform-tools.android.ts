import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Capacitor } from '@capacitor/core';
@Component({
  selector: 'app-platform-tools',
  imports: [RouterLink],
  template: `@if (android) {
    <a class="btn" routerLink="/sms-sync">SMS Sync · Review detected transactions</a>
  }`,
})
export class PlatformTools {
  readonly android = Capacitor.getPlatform() === 'android';
}
