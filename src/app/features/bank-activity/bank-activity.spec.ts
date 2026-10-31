import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { CardNestStore } from '../../core/services/card-nest-store';
import { BankActivityEvent, BankActivityProfile, bankActivitySummary } from './bank-activity-model';
import { BankActivityPage } from './bank-activity';
import { BankActivityService } from './bank-activity.service';

describe('Bank Activity date refresh', () => {
  const profile: BankActivityProfile = {
    id: 'midnight-bank-profile',
    bankName: 'Fictional Bank',
    accountSuffix: '123',
    owner: 'OWN',
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const event: BankActivityEvent = {
    id: 'midnight-bank-event',
    profileId: profile.id,
    activityDate: '2026-04-26',
    direction: 'DEBIT',
    origin: 'MANUAL',
    verification: 'USER_CONFIRMED',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:00:00Z',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [BankActivityPage],
      providers: [
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
        {
          provide: BankActivityService,
          useValue: {
            profiles: signal([profile]),
            events: signal([event]),
            reviewNotice: signal(''),
            candidates: signal([]),
            summaryFor: (_profileId: string, today: string) => bankActivitySummary([event], today),
            eventsFor: () => [event],
            transactionsFor: () => [],
            transactionDirection: () => undefined,
          },
        },
        {
          provide: CardNestStore,
          useValue: {
            paymentSources: signal([]),
            bankCashTracking: signal({ enabled: false, askCardSettlementFunding: false }),
          },
        },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  it('moves from Recently used to Not used recently at six calendar months without reload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T18:29:00Z'));
    const fixture = TestBed.createComponent(BankActivityPage);
    fixture.detectChanges();
    expect(fixture.componentInstance.today).toBe('2026-10-25');
    expect(fixture.componentInstance.statusLabel(profile)).toBe('Recently used');

    vi.setSystemTime(new Date('2026-10-25T18:31:00Z'));
    await vi.advanceTimersByTimeAsync(60_000);
    fixture.detectChanges();
    expect(fixture.componentInstance.today).toBe('2026-10-26');
    expect(fixture.componentInstance.statusLabel(profile)).toBe('Not used recently');
    fixture.destroy();
  });
});
