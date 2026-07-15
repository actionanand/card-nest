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
      const initialiseStorage = database
        .initialise()
        .then(() =>
          Promise.allSettled([
            themes.initialise(),
            pin.initialise(),
            store.initialisePreferences(),
          ]),
        );
      return Promise.allSettled([
        initialiseStorage,
        notifications.initialise(store.cards(), (cardId) => store.cardOutstanding(cardId)),
      ]).then(() => undefined);
    }),
  ],
};
