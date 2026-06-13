import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { checkSubscription, startSubscription } from "../utils/subscription";
import { supabase } from "../utils/supabase"; // ← add this

const SCREEN_WIDTH = Dimensions.get("window").width;

type Props = {
  visible: boolean;
  reason: "collections" | "photos" | "renewal";
  onClose: () => void;
  onSubscribed: () => void;
};

export default function PaywallModal({
  visible,
  reason,
  onClose,
  onSubscribed,
}: Props) {
  const [loading, setLoading] = useState(false);

  const title =
    reason === "collections"
      ? "Collection Limit Reached"
      : reason === "photos"
        ? "Photo Limit Reached"
        : "Your Subscription Has Expired";

  const message =
    reason === "collections"
      ? "Free accounts can create up to 3 collections. Subscribe to create unlimited collections."
      : reason === "photos"
        ? "Free accounts can store up to 10 photos per collection. Subscribe for unlimited photos."
        : "Your Mems subscription has expired. Renew now to continue enjoying unlimited collections and photos.";

  async function handleSubscribe(plan: "monthly" | "yearly") {
    setLoading(true);
    try {
      // Opens Pesapal — on web as popup, on mobile as in-app browser
      // Waits for popup/browser to close then syncs status
      await startSubscription(plan);

      // Check if payment was successful
      const status = await checkSubscription();

      if (status.isSubscribed) {
        // Payment successful — close modal and notify parent
        onClose();
        setTimeout(() => {
          if (Platform.OS === "web") {
            window.alert(
              "🎉 Subscription activated! You now have unlimited access.",
            );
          } else {
            Alert.alert("Subscribed! 🎉", "You now have unlimited access.");
          }
          onSubscribed();
        }, 300);
      } else {
        // Check sync result to see if it explicitly failed
        const { data: syncData } =
          await supabase.functions.invoke("sync-subscription");

        if (syncData?.status === "failed") {
          if (Platform.OS === "web") {
            window.alert("Payment failed. Please try again.");
          } else {
            Alert.alert(
              "Payment Failed",
              "Your payment was not completed. Please try again.",
            );
          }
        } else if (syncData?.activated) {
          // Just activated by sync
          onClose();
          onSubscribed();
        } else {
          // Still processing — retry once after 3 seconds
          setTimeout(async () => {
            const retryStatus = await checkSubscription();
            if (retryStatus.isSubscribed) {
              onClose();
              onSubscribed();
            } else {
              if (Platform.OS === "web") {
                window.alert(
                  "Payment is still processing. Please refresh the app in a moment.",
                );
              } else {
                Alert.alert(
                  "Almost there!",
                  "Your payment is still processing. Please try again in a few seconds.",
                  [{ text: "OK", onPress: onClose }],
                );
              }
            }
          }, 3000);
        }
      }
    } catch (error: any) {
      if (Platform.OS === "web") {
        window.alert("Payment error: " + error.message);
      } else {
        Alert.alert("Error", error.message);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.iconRow}>
            <Text style={styles.icon}>✨</Text>
          </View>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>

          <View style={styles.comparison}>
            <View style={styles.tier}>
              <Text style={styles.tierLabel}>Free</Text>
              <Text style={styles.tierItem}>✓ 3 collections</Text>
              <Text style={styles.tierItem}>✓ 10 photos each</Text>
              <Text style={styles.tierItem}>✓ Share collections</Text>
            </View>
            <View style={[styles.tier, styles.tierPaid]}>
              <Text style={[styles.tierLabel, styles.tierLabelPaid]}>Pro</Text>
              <Text style={[styles.tierItem, styles.tierItemPaid]}>
                ✓ 20 collections
              </Text>
              <Text style={[styles.tierItem, styles.tierItemPaid]}>
                ✓ 75 photos each
              </Text>
              <Text style={[styles.tierItem, styles.tierItemPaid]}>
                ✓ Share collections
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={[
              styles.planButton,
              styles.planButtonFeatured,
              loading && { opacity: 0.6 },
            ]}
            onPress={() => handleSubscribe("monthly")}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Text style={styles.planButtonTitle}>Monthly</Text>
                <Text style={styles.planButtonPrice}>KES 130 / month</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.planButton, loading && { opacity: 0.6 }]}
            onPress={() => handleSubscribe("yearly")}
            disabled={loading}
          >
            <View style={styles.saveBadge}>
              <Text style={styles.saveBadgeText}>Save 14%</Text>
            </View>
            <Text style={[styles.planButtonTitle, { color: "#111" }]}>
              Yearly
            </Text>
            <Text style={[styles.planButtonPrice, { color: "#555" }]}>
              KES 1,350 / year
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.dismissButton} onPress={onClose}>
            <Text style={styles.dismissText}>Maybe later</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    backgroundColor: "#fff",
    borderRadius: 24,
    padding: 24,
    alignItems: "center",
  },
  iconRow: { marginBottom: 8 },
  icon: { fontSize: 40 },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: "#111",
    textAlign: "center",
    marginBottom: 8,
  },
  message: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    marginBottom: 20,
    lineHeight: 20,
  },
  comparison: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
    marginBottom: 20,
  },
  tier: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    padding: 12,
  },
  tierPaid: { backgroundColor: "#111" },
  tierLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#111",
    marginBottom: 8,
  },
  tierLabelPaid: { color: "#fff" },
  tierItem: {
    fontSize: 12,
    color: "#555",
    marginBottom: 4,
  },
  tierItemPaid: { color: "rgba(255,255,255,0.85)" },
  planButton: {
    width: "100%",
    borderRadius: 14,
    padding: 16,
    alignItems: "center",
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#e0e0e0",
    position: "relative",
  },
  planButtonFeatured: {
    backgroundColor: "#111",
    borderColor: "#111",
  },
  planButtonTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 2,
  },
  planButtonPrice: {
    fontSize: 13,
    color: "rgba(255,255,255,0.8)",
  },
  saveBadge: {
    position: "absolute",
    top: -10,
    right: 16,
    backgroundColor: "#4AE8A0",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  saveBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#111",
  },
  dismissButton: {
    marginTop: 4,
    padding: 8,
  },
  dismissText: {
    fontSize: 13,
    color: "#999",
  },
});
