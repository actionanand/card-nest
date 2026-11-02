export const CONSUMER_WALLET_PROVIDERS = [
  { id: 'amazon-pay', label: 'Amazon Pay' },
  { id: 'paytm-wallet', label: 'Paytm Wallet' },
  { id: 'mobikwik-wallet', label: 'MobiKwik Wallet' },
  { id: 'phonepe-wallet', label: 'PhonePe Wallet' },
  { id: 'freecharge-wallet', label: 'Freecharge Wallet' },
  { id: 'airtel-money', label: 'Airtel Money' },
  { id: 'hdfc-payzapp-wallet', label: 'HDFC PayZapp Wallet' },
  { id: 'ola-money', label: 'Ola Money' },
  { id: 'google-play-store-payment', label: 'Google Play Store Payment' },
  { id: 'zomato-money', label: 'Zomato Money' },
  { id: 'tata-neu', label: 'Tata Neu' },
  { id: 'uber-cash', label: 'Uber Cash' },
  { id: 'swiggy-money', label: 'Swiggy Money' },
  { id: 'upi-lite', label: 'UPI Lite' },
  { id: 'bb-wallet', label: 'BB Wallet' },
  { id: 'hand-picked-wallet', label: 'Hand Picked Wallet' },
  { id: 'other', label: 'Other' },
] as const;

export type ConsumerWalletProviderId = (typeof CONSUMER_WALLET_PROVIDERS)[number]['id'];

export function consumerWalletProviderLabel(providerId: string): string {
  return (
    CONSUMER_WALLET_PROVIDERS.find((provider) => provider.id === providerId)?.label ?? providerId
  );
}
