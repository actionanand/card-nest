import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.actionanand.cardnest.app',
  appName: 'CardNest',
  webDir: 'dist/card-nest/browser',
  server: { androidScheme: 'https' },
  android: { backgroundColor: '#28684e' },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_card_nest',
      iconColor: '#ffffff',
    },
  },
};

export default config;
