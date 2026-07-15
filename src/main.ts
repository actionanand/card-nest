import { bootstrapApplication } from '@angular/platform-browser';
import { Capacitor } from '@capacitor/core';
import { defineCustomElements } from 'jeep-sqlite/loader';
import { appConfig } from './app/app.config';
import { App } from './app/app';

if (Capacitor.getPlatform() === 'web') {
  defineCustomElements(window);
}

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
