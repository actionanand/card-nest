// Capacitor passes CAPACITOR_PLATFORM_NAME to project hooks.
if (process.env.CAPACITOR_PLATFORM_NAME === 'android') await import('./patch-android.mjs');
