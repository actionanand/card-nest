import { NgOptimizedImage } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { AppIcon } from './app-icon';
import { WhatsAppPackage } from '../features/utilities/whatsapp.service';

@Component({
  selector: 'app-whatsapp-app-chooser',
  imports: [AppIcon, NgOptimizedImage],
  templateUrl: './whatsapp-app-chooser.html',
  styleUrl: './whatsapp-app-chooser.scss',
})
export class WhatsAppAppChooser {
  readonly packages = input.required<readonly WhatsAppPackage[]>();
  readonly chosen = output<WhatsAppPackage>();
  readonly closed = output<void>();

  appName(packageName: WhatsAppPackage): string {
    return packageName === 'com.whatsapp.w4b' ? 'WhatsApp Business' : 'WhatsApp';
  }

  appIcon(packageName: WhatsAppPackage): string {
    return packageName === 'com.whatsapp.w4b' ? '/whatsapp-business.png' : '/whatsapp.png';
  }
}
