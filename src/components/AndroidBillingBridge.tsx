// Thin wrapper around expo-iap's useIAP() hook, scoped entirely to Google
// Play Billing on Android.
//
// This component must ONLY ever be mounted when Platform.OS === "android".
// expo-iap has no web implementation (its expo-module.config.json lists
// only ios/tvos/android), and useIAP() calls initConnection() on mount
// automatically — on web that reaches for a native module that doesn't
// exist and throws. PaywallModal.tsx is responsible for the
// `Platform.OS === "android" && <AndroidBillingBridge ... />` guard; this
// file assumes that guard is already in place and does no platform
// checking of its own.
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { ErrorCode, useIAP, type Purchase } from "expo-iap";
import {
  ANDROID_SUBSCRIPTION_SKUS,
  TIER_RANK,
  tierForAndroidProductId,
  verifyAndroidPurchase,
  type Tier,
} from "../utils/googlePlayBilling";

export type AndroidBillingHandle = {
  purchase: (tier: Tier) => Promise<void>;
};

type Props = {
  // Called once a purchase has been verified server-side and the
  // transaction has been finished — the PaywallModal caller can treat
  // this exactly like a completed Pesapal purchase.
  onPurchaseSuccess: (tier: Tier) => void;
  // `message` is null for events that shouldn't surface an alert (e.g.
  // the user simply cancelled the Play Store sheet) — the caller should
  // just clear its "purchasing" state in that case. Any other value is
  // a user-facing error message to show.
  onPurchaseError: (message: string | null) => void;
  // Set when the user already has an active Google Play subscription for
  // a DIFFERENT tier than the one about to be purchased. When present,
  // purchase() performs an in-place upgrade/downgrade (Google Play's
  // subscription "replacement" flow, via subscriptionProductReplacementParams)
  // instead of creating a second, independent subscription that would
  // double-charge the user. Omit/null for a normal new purchase.
  currentSubscription?: { tier: Tier; purchaseToken: string } | null;
};

const ALL_SKUS = Object.values(ANDROID_SUBSCRIPTION_SKUS);

const AndroidBillingBridge = forwardRef<AndroidBillingHandle, Props>(
  ({ onPurchaseSuccess, onPurchaseError, currentSubscription }, ref) => {
    const {
      connected,
      subscriptions,
      fetchProducts,
      requestPurchase,
      finishTransaction,
    } = useIAP({
      onPurchaseSuccess: async (purchase: Purchase) => {
        const tier = tierForAndroidProductId(purchase.productId);
        if (!tier) {
          // A purchase came back for a SKU we don't recognize — don't
          // silently finish it (that would risk consuming a purchase
          // we don't actually understand); surface it instead.
          console.error(
            "[AndroidBilling] Purchase for unknown product:",
            purchase.productId,
          );
          onPurchaseError(
            "Something went wrong with that purchase. Please contact support.",
          );
          return;
        }

        if (!purchase.purchaseToken) {
          console.error("[AndroidBilling] Purchase missing purchaseToken");
          onPurchaseError("Something went wrong. Please try again.");
          return;
        }

        try {
          // Verify server-side BEFORE finishing the transaction — never
          // trust the client's claim that a purchase succeeded. If this
          // throws (e.g. the verify-google-purchase function isn't
          // deployed yet), the transaction is deliberately left
          // unacknowledged: Google auto-refunds unacknowledged
          // purchases after 3 days, which is the safety net here.
          const result = await verifyAndroidPurchase({
            tier,
            productId: purchase.productId,
            purchaseToken: purchase.purchaseToken,
          });

          if (result.status !== "active") {
            onPurchaseError(
              "Payment could not be confirmed. Please try again.",
            );
            return;
          }

          await finishTransaction({ purchase, isConsumable: false });
          onPurchaseSuccess(tier);
        } catch (err: any) {
          console.error(
            "[AndroidBilling] verifyAndroidPurchase failed:",
            err?.message,
          );
          onPurchaseError("Payment could not be verified. Please try again.");
        }
      },
      onPurchaseError: (error) => {
        if (error.code === ErrorCode.UserCancelled) {
          onPurchaseError(null);
          return;
        }
        console.error("[AndroidBilling] Purchase error:", error.message);
        onPurchaseError(
          error.message || "Payment could not be started. Please try again.",
        );
      },
    });

    useEffect(() => {
      if (connected) {
        fetchProducts({ skus: ALL_SKUS, type: "subs" });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected]);

    useImperativeHandle(
      ref,
      () => ({
        purchase: async (tier: Tier) => {
          if (!connected) {
            throw new Error(
              "Still connecting to Google Play. Please try again in a moment.",
            );
          }

          const sku = ANDROID_SUBSCRIPTION_SKUS[tier];
          const product = subscriptions.find(
            (s) => s.id === sku && s.platform === "android",
          );

          if (!product) {
            throw new Error(
              "This plan isn't available yet. Please try again shortly.",
            );
          }

          const offerToken = product.subscriptionOffers?.[0]?.offerTokenAndroid;
          if (!offerToken) {
            throw new Error(
              "This plan isn't available yet. Please try again shortly.",
            );
          }

          // Replacement (in-place upgrade/downgrade) vs a normal new
          // purchase: if the caller says there's already an active Google
          // Play subscription for a DIFFERENT tier, pass Google Play's
          // subscription-replacement params instead of just requesting a
          // second, independent subscription (which would leave both
          // active and double-charge the user going forward).
          const isReplacement =
            !!currentSubscription && currentSubscription.tier !== tier;
          const isUpgrade =
            isReplacement &&
            TIER_RANK[tier] > TIER_RANK[currentSubscription!.tier];

          await requestPurchase({
            request: {
              google: {
                skus: [sku],
                subscriptionOffers: [{ sku, offerToken }],
                ...(isReplacement
                  ? {
                      // The previous subscription's purchase token — required
                      // by Google Play to link the replacement to what it's
                      // replacing.
                      purchaseToken: currentSubscription!.purchaseToken,
                      subscriptionProductReplacementParams: {
                        oldProductId:
                          ANDROID_SUBSCRIPTION_SKUS[currentSubscription!.tier],
                        // Upgrades take effect immediately with a prorated
                        // charge for the remainder of the period — the
                        // normal, expected "upgrade now" behavior.
                        // Downgrades are deferred to the next renewal
                        // instead, so the user keeps what they already paid
                        // for this period rather than getting an
                        // immediate-but-confusing partial credit.
                        replacementMode: isUpgrade
                          ? "with-time-proration"
                          : "deferred",
                      },
                    }
                  : {}),
              },
            },
            type: "subs",
          });
        },
      }),
      [connected, subscriptions, requestPurchase, currentSubscription],
    );

    return null;
  },
);

AndroidBillingBridge.displayName = "AndroidBillingBridge";

export default AndroidBillingBridge;
