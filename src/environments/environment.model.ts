export interface AppEnvironment {
  readonly smsPageSize: number;
  /** Only eligible first-run initialization may consume this flag. Never a reset. */
  readonly seedDemoData: boolean;
}
