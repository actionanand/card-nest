import { Capacitor, registerPlugin } from '@capacitor/core';
const discovery = registerPlugin<{ clear(): Promise<void> }>('CardNestSms');
export async function clearPlatformDiscovery(): Promise<void> {
  if (Capacitor.getPlatform() === 'android') await discovery.clear();
}
