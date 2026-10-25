import { CylinderSize } from './data/cylinder-options';
import { LpgProvider } from './data/lpg-providers';
import { MobileOperator } from './data/mobile-operators';
import { MobilePlanType, MobileSubscriptionType } from './data/mobile-plan-types';

export interface UtilitySettings {
  readonly showIndianUtilities: boolean;
  readonly utilityReminders: boolean;
}

export interface MobileProfile {
  readonly id: string;
  readonly kind: 'MOBILE';
  readonly personName: string;
  readonly subscriptionType: MobileSubscriptionType;
  readonly operator: MobileOperator;
  readonly mobileNumber?: string;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MobileRecharge {
  readonly id: string;
  readonly profileId: string;
  readonly planType: MobilePlanType;
  readonly amountMinor?: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly comment?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LpgProfile {
  readonly id: string;
  readonly kind: 'LPG';
  readonly connectionName: string;
  readonly provider: LpgProvider;
  readonly commercial: boolean;
  readonly mobileNumber?: string;
  readonly connectionId?: string;
  readonly distributorId?: string;
  readonly distributorName?: string;
  readonly distributorContact?: string;
  readonly distributorWhatsApp?: string;
  readonly cylinderSize: CylinderSize;
  readonly estimatedUsageDays: number;
  readonly notes?: string;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type LpgEventType = 'STARTED' | 'EMPTY' | 'REFILL_RECEIVED';

export interface LpgEvent {
  readonly id: string;
  readonly profileId: string;
  readonly eventType: LpgEventType;
  readonly eventDate: string;
  readonly amountMinor?: number;
  readonly cylinderSize?: CylinderSize;
  readonly comment?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
