import { ApplicationInitStatus, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { appConfig } from './app.config';
import { SqliteDatabase } from './core/data/sqlite-database';
import { CardNestStore } from './core/services/card-nest-store';
import { NotificationService } from './core/services/notification.service';
import { ThemeService } from './core/services/theme.service';
import { ApplicationPinService } from './core/services/application-pin.service';
import { AppLockService } from './core/services/app-lock.service';
import { SensitiveCardDataService } from './core/services/sensitive-card-data.service';
import { DateFormatService } from './core/services/date-format.service';
import { CardExpiryService } from './core/services/card-expiry.service';
import { UtilitiesService } from './features/utilities/utilities.service';
import { BankActivityService } from './features/bank-activity/bank-activity.service';

describe('existing application initialization completion', () => {
  it('still completes independent app startup when the store reports its preserved scheduling failure', async () => {
    const failure = new Error('Synthetic preserved scheduling failure');
    const store = {
      initialisePreferences: vi.fn().mockRejectedValue(failure),
      initialisationWarning: signal(failure.message),
      cards: signal([]),
      cardDueAmount: vi.fn(() => 0),
    };
    const lock = { initialise: vi.fn().mockResolvedValue(undefined) };
    const notifications = {
      setUtilityReminders: vi.fn(),
      initialise: vi.fn().mockResolvedValue(undefined),
    };
    TestBed.configureTestingModule({
      providers: [
        ...appConfig.providers,
        { provide: SqliteDatabase, useValue: { initialise: vi.fn().mockResolvedValue(undefined) } },
        { provide: CardNestStore, useValue: store },
        { provide: AppLockService, useValue: lock },
        { provide: NotificationService, useValue: notifications },
        ...[
          ThemeService,
          ApplicationPinService,
          SensitiveCardDataService,
          DateFormatService,
          CardExpiryService,
          BankActivityService,
        ].map((token) => ({
          provide: token,
          useValue: { initialise: vi.fn().mockResolvedValue(undefined) },
        })),
        {
          provide: UtilitiesService,
          useValue: { initialise: vi.fn().mockResolvedValue(undefined), reminderTargets: () => [] },
        },
      ],
    });
    const status = TestBed.inject(ApplicationInitStatus);
    // TestBed runs the configured application initializers when it finalizes the injector.
    await expect(status.donePromise).resolves.toBeUndefined();
    expect(status.done).toBe(true);
    expect(store.initialisePreferences).toHaveBeenCalledOnce();
    expect(lock.initialise).toHaveBeenCalledOnce();
    expect(notifications.initialise).toHaveBeenCalledOnce();
    expect(store.initialisationWarning()).toBe(failure.message);
  });
});
