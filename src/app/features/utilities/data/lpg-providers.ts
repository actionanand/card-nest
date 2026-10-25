export const LPG_PROVIDERS = [
  { value: 'HPCL', label: 'HPCL' },
  { value: 'BPCL', label: 'BPCL' },
  { value: 'INDANE', label: 'Indane' },
] as const;

export type LpgProvider = (typeof LPG_PROVIDERS)[number]['value'];

export const GAS_SERVICE_TYPES = [
  { value: 'LPG', label: 'LPG' },
  { value: 'PNG', label: 'PNG' },
] as const;

export type GasServiceType = (typeof GAS_SERVICE_TYPES)[number]['value'];
