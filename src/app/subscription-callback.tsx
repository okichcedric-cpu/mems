import { hasPendingUploadHint } from "@/utils/pendingUpload";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";

export default function SubscriptionCallback() {
  const params = useLocalSearchParams();
  const router = useRouter();

  useEffect(() => {
    // Web only below this point. This route can still end up mounted on
    // native — app.json sets scheme: "mems", so expo-router's own
    // built-in deep-link handling treats mems://subscription-callback as
    // "navigate to this screen", on top of (separately) app/_layout.tsx's
    // raw Linking listener also watching for the exact same URL. That's
    // not something controllable from _layout.tsx — expo-router pushes
    // this route regardless of what that listener does.
    //
    // `typeof window !== "undefined"` doesn't guard against running on
    // native at all — React Native provides a `window` global too, just
    // without .location/.opener/.close() — so this used to fall through
    // to `window.location.href = ...` and throw ("cannot set
    // location.href"), crashing the app on every native return from
    // payment.
    //
    // The real handling on native (dismissing the browser, deciding
    // where to route, resuming an upload) already happens correctly on
    // the screen this one got pushed on top of — via _layout.tsx's
    // listener — so simply not touching any window API isn't enough on
    // its own; this screen also needs to get out of the way, or the user
    // is left staring at "Processing payment..." forever with nothing
    // ever navigating past it. Popping back off the stack reveals that
    // already-working screen again immediately, without disturbing its
    // mount state the way a replace() to some other destination would.
    if (Platform.OS !== "web") {
      if (router.canGoBack()) router.back();
      else router.replace("/");
      return;
    }

    // This page loads inside the Pesapal popup after payment
    // It signals the parent window and closes itself
    const orderTrackingId = params.OrderTrackingId as string;
    const merchantReference = params.OrderMerchantReference as string;

    console.log("Callback received:", { orderTrackingId, merchantReference });

    // Signal the parent window that payment is complete
    if (window.opener) {
      window.opener.postMessage(
        {
          type: "PESAPAL_PAYMENT_COMPLETE",
          orderTrackingId,
          merchantReference,
        },
        window.location.origin,
      );
      // Close the popup
      window.close();
    } else {
      // No opener means the popup was blocked and PaywallModal fell
      // back to a same-tab redirect instead — this page load IS that
      // original tab coming back, with all its previous React state
      // (including any photos the user had picked) gone. If it saved a
      // draft to IndexedDB before leaving (see utils/pendingUpload.ts),
      // send it back to New Collection so it can pick that draft up
      // and finish the upload automatically; otherwise home is still
      // the right default (e.g. a purchase from the standalone
      // Subscription page has nothing to resume).
      window.location.href = hasPendingUploadHint() ? "/new-collection" : "/";
    }
  }, []);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#111" />
      <Text style={styles.text}>Processing payment...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
    gap: 16,
  },
  text: {
    fontSize: 16,
    color: "#666",
  },
});
