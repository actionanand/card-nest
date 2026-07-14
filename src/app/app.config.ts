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
      return Promise.allSettled([
        database.initialise().then(() => themes.initialise()),
        notifications.initialise(store.cards(), (cardId) => store.cardOutstanding(cardId)),
      ]).then(() => undefined);
    }),
  ],
};
