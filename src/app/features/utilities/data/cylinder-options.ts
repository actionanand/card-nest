export const CYLINDER_OPTIONS = [
  { value: 'SMALL', label: 'Small' },
  { value: 'NORMAL', label: 'Normal' },
] as const;

export type CylinderSize = (typeof CYLINDER_OPTIONS)[number]['value'];
