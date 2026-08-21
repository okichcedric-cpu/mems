// Android-only Google Play Billing support.
//
// This file is the single source of truth for tier <-> Play Console
// product ID mapping, and for the client-side call into the (not yet
// built) server-side purchase verification function. It has zero
// dependency on the `expo-iap` package itself — that's deliberate, so
// this file stays safe to import from anywhere (including web/iOS code
// paths) without ever touching the native billing module. The actual
// `expo-iap` calls live in AndroidBillingBridge.tsx, which is only ever
// mounted on Android.
import { supabase } from "./supabase";

// Subscription tier — shared between the web/Pesapal flow (PaywallModal,
// subscription.tsx) and the Android/Google Play flow (this file,
// AndroidBillingBridge.tsx). Kept here rather than in PaywallModal.tsx
// so neither file needs to import the other for the type alone.
export type Tier = "small" | "medium" | "big";

// Play Console subscription product IDs, one per tier, each with a single
// monthly auto-renewing base plan (see Phase 1 setup guide). These are
// placeholders until the matching products are created in Play Console —
// update here once the real product IDs are finalized there, and nothing
// else in the app needs to change.
export const ANDROID_SUBSCRIPTION_SKUS: Record<Tier, string> = {
  small: "mems_small_monthly",
  medium: "mems_medium_monthly",
  big: "mems_big_monthly",
};

export function tierForAndroidProductId(productId: string): Tier | null {
  const entry = (
    Object.entries(ANDROID_SUBSCRIPTION_SKUS) as [Tier, string][]
  ).find(([, sku]) => sku === productId);
  return entry ? entry[0] : null;
}

// Relative ordering of paid tiers — used to tell an upgrade from a downgrade
// when a Google Play subscriber switches tiers in-place (see
// AndroidBillingBridge's replacement-purchase handling). Higher number =
// more expensive/more storage.
export const TIER_RANK: Record<Tier, number> = {
  small: 1,
  medium: 2,
  big: 3,
};

type VerifyAndroidPurchaseParams = {
  tier: Tier;
  productId: string;
  purchaseToken: string;
};

type VerifyAndroidPurchaseResult = {
  status: "active" | "failed";
};

// Calls the server-side purchase verification function. This mirrors the
// existing sync-subscription contract ({ status: "active" | ... }) so
// AndroidBillingBridge can treat a Google Play purchase the same way
// PaywallModal already treats a Pesapal one.
//
// NOTE: the `verify-google-purchase` edge function itself doesn't exist
// yet — it's built in a later phase, once the Play Console service
// account is set up (that's a manual, one-time console step the app
// can't do on its own). Until then, calling this will fail with a
// "function not found" error from Supabase, which the caller surfaces
// as a normal payment error — nothing is silently granted, and the
// purchase is left unacknowledged so Google's own 3-day auto-refund
// safety net still applies. No client code will need to change once
// the function is deployed.
export async function verifyAndroidPurchase(
  params: VerifyAndroidPurchaseParams,
): Promise<VerifyAndroidPurchaseResult> {
  const { data, error } = await supabase.functions.invoke(
    "verify-google-purchase",
    { body: params },
  );

  if (error) {
    throw new Error(
      error.message || "Purchase could not be verified. Please try again.",
    );
  }

  return data as VerifyAndroidPurchaseResult;
}
