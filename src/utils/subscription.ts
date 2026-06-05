import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { supabase } from './supabase';

export type SubscriptionStatus = {
  isSubscribed: boolean;
  plan: string;
  expiresAt: string | null;
  wasSubscribed: boolean;
  limits: { maxCollections: number; maxPhotosPerCollection: number } | null;
};

export async function checkSubscription(): Promise<SubscriptionStatus> {
  const { data, error } = await supabase.functions.invoke('check-subscription');
  if (error) {
    return {
      isSubscribed: false,
      plan: 'free',
      expiresAt: null,
      wasSubscribed: false,
      limits: { maxCollections: 3, maxPhotosPerCollection: 10 },
    };
  }
  return data;
}

export async function startSubscription(plan: 'monthly' | 'yearly'): Promise<void> {
  // Use the callback page as the redirect URL
  const callbackUrl = Platform.OS === 'web'
    ? `${window.location.origin}/subscription-callback`
    : 'mems://subscription-callback';

  const { data, error } = await supabase.functions.invoke('create-subscription', {
    body: { plan, callbackUrl },
  });

  if (error) throw new Error(error.message);
  if (!data?.redirect_url) throw new Error('No payment URL received');

  if (Platform.OS === 'web') {
    // Open Pesapal in a popup window
    const popup = window.open(
      data.redirect_url,
      'pesapal_payment',
      'width=600,height=700,scrollbars=yes,resizable=yes,left=' +
        (window.screen.width / 2 - 300) +
        ',top=' +
        (window.screen.height / 2 - 350)
    );

    if (!popup) {
      // Popup was blocked — fall back to new tab
      window.open(data.redirect_url, '_blank');
      // Poll for subscription activation
      await pollForActivation();
      return;
    }

    // Wait for postMessage from callback page OR popup close
    await new Promise<void>((resolve) => {
      const messageHandler = (event: MessageEvent) => {
        if (
          event.origin === window.location.origin &&
          event.data?.type === 'PESAPAL_PAYMENT_COMPLETE'
        ) {
          window.removeEventListener('message', messageHandler);
          clearInterval(pollInterval);
          resolve();
        }
      };

      // Listen for message from callback page
      window.addEventListener('message', messageHandler);

      // Also poll in case popup closes without message
      const pollInterval = setInterval(() => {
        if (!popup || popup.closed) {
          clearInterval(pollInterval);
          window.removeEventListener('message', messageHandler);
          resolve();
        }
      }, 1000);
    });
  } else {
    // Mobile — use in-app browser
    await WebBrowser.openBrowserAsync(data.redirect_url);
  }

  // Sync subscription status after popup closes
  await syncSubscription();
}

async function pollForActivation(maxAttempts = 10): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await checkSubscription();
    if (status.isSubscribed) return;
  }
}

export async function syncSubscription(): Promise<{ activated: boolean; status?: string }> {
  const { data, error } = await supabase.functions.invoke('sync-subscription');
  if (error) {
    console.warn('Sync failed:', error.message);
    return { activated: false };
  }
  return data ?? { activated: false };
}