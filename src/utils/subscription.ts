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
    price: 320,
  },
  medium: {
    label: "Medium Album",
    maxCollections: 30,
    maxPhotosPerCollection: 50,
    price: 600,
  },
  big: {
    label: "Big Album",
    maxCollections: 50,
    maxPhotosPerCollection: 75,
    price: 1150,
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