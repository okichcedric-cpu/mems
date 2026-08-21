import { supabase } from "./supabase";

export type Tier = "free" | "small" | "medium" | "big";

export type TierLimits = {
  label: string;
  maxCollections: number;
  maxPhotosPerCollection: number;
  price: number;
};

export type SubscriptionStatus = {
  tier: Tier;
  isActive: boolean;
  limits: TierLimits;
  amount?: number;
  currency?: string;
  // Which provider the current subscription (if any) is on — only
  // meaningful when isActive is true. Lets PaywallModal block starting a
  // purchase through the OTHER provider while one is already active, since
  // Google Play auto-renews silently and a Pesapal purchase on top (or
  // vice versa) would risk a real double-charge.
  paymentProvider?: "pesapal" | "google_play" | null;
  // Only present when paymentProvider is "google_play" — lets PaywallModal
  // perform an in-place tier upgrade/downgrade (Google Play's subscription
  // replacement flow) instead of starting a second, independent
  // subscription when switching tiers.
  googlePlayPurchaseToken?: string | null;
};

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: {
    label: "Free",
    maxCollections: 3,
    maxPhotosPerCollection: 10,
    price: 0,
  },
  small: {
    label: "Small Album",
    maxCollections: 15,
    maxPhotosPerCollection: 35,
    price: 99,
  },
  medium: {
    label: "Medium Album",
    maxCollections: 30,
    maxPhotosPerCollection: 50,
    price: 179,
  },
  big: {
    label: "Big Album",
    maxCollections: 50,
    maxPhotosPerCollection: 75,
    price: 299,
  },
};

export async function checkSubscription(): Promise<SubscriptionStatus> {
  try {
    const { data, error } = await supabase.functions.invoke(
      "check-subscription",
    );
    if (error) throw new Error(error.message);
    return {
      tier: data.tier ?? "free",
      isActive: data.isActive ?? false,
      limits: data.limits ?? TIER_LIMITS.free,
      amount: data.amount,
      currency: data.currency,
      paymentProvider: data.paymentProvider ?? null,
      googlePlayPurchaseToken: data.googlePlayPurchaseToken ?? null,
    };
  } catch {
    return {
      tier: "free",
      isActive: false,
      limits: TIER_LIMITS.free,
    };
  }
}

export async function startSubscription(
  tier: Tier,
  callbackUrl: string,
): Promise<{ redirectUrl: string; merchantReference: string }> {
  const { data, error } = await supabase.functions.invoke(
    "create-subscription",
    { body: { tier, callbackUrl } },
  );
  if (error) throw new Error(error.message);
  return data;
}

export async function syncSubscription(): Promise<{
  status: string;
  tier: Tier;
}> {
  const { data, error } = await supabase.functions.invoke("sync-subscription");
  if (error) throw new Error(error.message);
  return data;
}