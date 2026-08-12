import { hasPendingUploadHint } from "@/utils/pendingUpload";
import { useLocalSearchParams } from "expo-router";
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

  useEffect(() => {
    // Web only. This route can still end up mounted on native — app.json
    // sets scheme: "mems", so expo-router's own built-in deep-link
    // handling treats mems://subscription-callback as "navigate to this
    // screen", on top of (separately) app/_layout.tsx's raw Linking
    // listener also watching for the exact same URL. `typeof window !==
    // "undefined"` doesn't guard against that — React Native provides a
    // `window` global too, just without .location/.opener/.close() — so
    // this used to fall through to `window.location.href = ...` on
    // native and throw ("cannot set location.href"), crashing the app on
    // every single native return from payment. _layout.tsx's listener is
    // the real handler on native (dismisses the browser, decides where
    // to route); this screen has nothing to do there, so it just stays
    // inert and lets that own its job rather than racing it.
    if (Platform.OS !== "web") return;

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
