import { Capacitor, registerPlugin } from '@capacitor/core';
const discovery = registerPlugin<{
  clear(): Promise<void>;
  prune(options: { cutoff: string }): Promise<void>;
}>('CardNestSms');
export async function clearPlatformDiscovery(): Promise<void> {
  if (Capacitor.getPlatform() === 'android') await discovery.clear();
}
export async function prunePlatformDiscovery(cutoff: string): Promise<void> {
  if (Capacitor.getPlatform() === 'android') await discovery.prune({ cutoff });
}
