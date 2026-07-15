import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { SqliteDatabase } from './core/data/sqlite-database';
import { CardNestStore } from './core/services/card-nest-store';
import { NotificationService } from './core/services/notification.service';
import { ThemeService } from './core/services/theme.service';
import { ApplicationPinService } from './core/services/application-pin.service';
import { AppLockService } from './core/services/app-lock.service';
import { SensitiveCardDataService } from './core/services/sensitive-card-data.service';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideAppInitializer(() => {
      const database = inject(SqliteDatabase);
      const store = inject(CardNestStore);
      const notifications = inject(NotificationService);
      const themes = inject(ThemeService);
      const pin = inject(ApplicationPinService);
      const appLock = inject(AppLockService);
      const cardSecrets = inject(SensitiveCardDataService);
      const initialiseStorage = database
        .initialise()
        .then(() =>
          Promise.allSettled([
            themes.initialise(),
            pin.initialise(),
            cardSecrets.initialise(),
            store.initialisePreferences(),
          ]),
        )
        .then(() => appLock.initialise());
      return initialiseStorage
        .then(() =>
          notifications.initialise(store.cards(), (cardId) => store.cardOutstanding(cardId)),
        )
        .catch(() => undefined);
    }),
  ],
};
