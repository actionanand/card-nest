import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.actionanand.cardnest.app',
  appName: 'CardNest',
  webDir: 'dist/card-nest/browser',
  server: { androidScheme: 'https' },
  android: { backgroundColor: '#f5f6f1' },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_card_nest',
      iconColor: '#28684e',
    },
  },
};

export default config;
