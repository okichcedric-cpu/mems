import { useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

export default function SubscriptionCallback() {
  const params = useLocalSearchParams();

  useEffect(() => {
    // This page loads inside the Pesapal popup after payment
    // It signals the parent window and closes itself
    if (typeof window !== "undefined") {
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
        // Opened as a tab not a popup — redirect to home
        window.location.href = "/";
      }
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
