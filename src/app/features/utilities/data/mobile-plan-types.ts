export const MOBILE_PLAN_TYPES = [
  { value: 'VOICE_DATA', label: 'Voice + Data', voice: true, data: true },
  { value: 'VOICE_ONLY', label: 'Voice Only', voice: true, data: false },
  { value: 'DATA_ONLY', label: 'Data only', voice: false, data: true },
] as const;

export type MobilePlanType = (typeof MOBILE_PLAN_TYPES)[number]['value'];

export const MOBILE_SUBSCRIPTION_TYPES = [
  { value: 'PREPAID', label: 'Prepaid' },
  { value: 'POSTPAID', label: 'Postpaid' },
] as const;

export type MobileSubscriptionType = (typeof MOBILE_SUBSCRIPTION_TYPES)[number]['value'];
