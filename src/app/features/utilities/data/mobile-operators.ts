export const MOBILE_OPERATORS = [
  { value: 'BSNL', label: 'BSNL' },
  { value: 'JIO', label: 'JIO' },
  { value: 'AIRTEL', label: 'Airtel' },
  { value: 'VI', label: 'VI' },
] as const;

export type MobileOperator = (typeof MOBILE_OPERATORS)[number]['value'];
