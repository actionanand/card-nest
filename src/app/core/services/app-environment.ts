import { InjectionToken } from '@angular/core';
import { environment } from '../../../environments/environment';
import { AppEnvironment } from '../../../environments/environment.model';

/** The build environment is authoritative; injectable to exercise both first-run modes. */
export const APP_ENVIRONMENT = new InjectionToken<AppEnvironment>('CardNest build environment', {
  providedIn: 'root',
  factory: () => environment,
});
