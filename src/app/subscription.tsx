import { supabase } from "@/utils/supabase";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  checkSubscription,
  startSubscription,
  SubscriptionStatus,
} from "../utils/subscription";

export default function SubscriptionPage() {
  const router = useRouter();
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [subscribing, setSubscribing] = useState<"monthly" | "yearly" | null>(
    null,
  );

  useEffect(() => {
    checkSubscription().then((s) => {
      setStatus(s);
      setLoading(false);
    });
  }, []);

  async function handleSubscribe(plan: "monthly" | "yearly") {
    setSubscribing(plan);
    try {
      await startSubscription(plan);
      const updated = await checkSubscription();
      setStatus(updated);
      if (updated.isSubscribed) {
        if (Platform.OS === "web") {
          window.alert(
            "🎉 Subscription activated! You now have unlimited access.",
          );
        } else {
          Alert.alert("Subscribed! 🎉", "You now have unlimited access.");
        }
      }
    } catch (error: any) {
      if (Platform.OS === "web") {
        window.alert("Error: " + error.message);
      } else {
        Alert.alert("Error", error.message);
      }
    } finally {
      setSubscribing(null);
    }
  }

  // Add cancel function
  async function handleCancel() {
    const confirmed =
      Platform.OS === "web"
        ? window.confirm(
            "Are you sure you want to cancel? You will keep access until your current period ends.",
          )
        : await new Promise<boolean>((resolve) => {
            Alert.alert(
              "Cancel Subscription",
              "Are you sure? You will keep access until your current period ends.",
              [
                {
                  text: "Keep Subscription",
                  style: "cancel",
                  onPress: () => resolve(false),
                },
                {
                  text: "Cancel",
                  style: "destructive",
                  onPress: () => resolve(true),
                },
              ],
            );
          });

    if (!confirmed) return;

    setCancelling(true);
    try {
      const { error } = await supabase.functions.invoke("cancel-subscription");
      if (error) throw new Error(error.message);
      const updated = await checkSubscription();
      setStatus(updated);
      if (Platform.OS === "web") {
        window.alert(
          "Subscription cancelled. You have access until your period ends.",
        );
      } else {
        Alert.alert(
          "Cancelled",
          "Your subscription has been cancelled. You keep access until your period ends.",
        );
      }
    } catch (error: any) {
      Alert.alert("Error", error.message);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Subscription</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color="#111" />
          </View>
        ) : (
          <>
            {/* Current status */}
            <View style={styles.statusCard}>
              {status?.isSubscribed ? (
                <>
                  <View style={styles.statusIconRow}>
                    <Text style={styles.statusIcon}>✨</Text>
                  </View>
                  <Text style={styles.statusTitle}>You're on Pro</Text>
                  <Text style={styles.statusSubtitle}>
                    Unlimited collections and photos
                  </Text>
                  {status.expiresAt && (
                    <View style={styles.renewalBadge}>
                      <Text style={styles.renewalText}>
                        Renews{" "}
                        {new Date(status.expiresAt).toLocaleDateString(
                          "en-KE",
                          {
                            day: "numeric",
                            month: "long",
                            year: "numeric",
                          },
                        )}
                      </Text>
                    </View>
                  )}
                </>
              ) : (
                <>
                  <View style={styles.statusIconRow}>
                    <Text style={styles.statusIcon}>🗂️</Text>
                  </View>
                  <Text style={styles.statusTitle}>Free Plan</Text>
                  <Text style={styles.statusSubtitle}>
                    3 collections · 10 photos each
                  </Text>
                </>
              )}
            </View>

            {/* Feature comparison */}
            <View style={styles.comparisonCard}>
              <Text style={styles.comparisonTitle}>What's included</Text>

              {[
                {
                  icon: "images-outline",
                  label: "Collections",
                  free: "Up to 3",
                  pro: "Up to 20",
                },
                {
                  icon: "camera-outline",
                  label: "Photos per collection",
                  free: "Up to 10",
                  pro: "Up to 75",
                },
                {
                  icon: "share-outline",
                  label: "Share collections",
                  free: "✓",
                  pro: "✓",
                },
                {
                  icon: "shield-checkmark-outline",
                  label: "Secure cloud storage",
                  free: "✓",
                  pro: "✓",
                },
              ].map((feature) => (
                <View key={feature.label} style={styles.featureRow}>
                  <Ionicons
                    name={feature.icon as any}
                    size={18}
                    color="#666"
                    style={styles.featureIcon}
                  />
                  <Text style={styles.featureLabel}>{feature.label}</Text>
                  <View style={styles.featureValues}>
                    <Text style={styles.featureFree}>{feature.free}</Text>
                    <Text style={styles.featurePro}>{feature.pro}</Text>
                  </View>
                </View>
              ))}

              <View style={styles.featureHeader}>
                <View style={styles.featureHeaderSpacer} />
                <View style={styles.featureHeaderLabels}>
                  <Text style={styles.featureHeaderFree}>Free</Text>
                  <Text style={styles.featureHeaderPro}>Pro</Text>
                </View>
              </View>
            </View>

            {/* Plans — only show if not subscribed */}
            {!status?.isSubscribed && (
              <View style={styles.plansSection}>
                <Text style={styles.plansTitle}>Choose a plan</Text>

                {/* Monthly */}
                <TouchableOpacity
                  style={styles.planCard}
                  onPress={() => handleSubscribe("monthly")}
                  disabled={!!subscribing}
                >
                  {subscribing === "monthly" ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <View style={styles.planInfo}>
                        <Text style={styles.planName}>Monthly</Text>
                        <Text style={styles.planDesc}>Billed every month</Text>
                      </View>
                      <Text style={styles.planPrice}>KES 130</Text>
                    </>
                  )}
                </TouchableOpacity>

                {/* Yearly */}
                <TouchableOpacity
                  style={[styles.planCard, styles.planCardFeatured]}
                  onPress={() => handleSubscribe("yearly")}
                  disabled={!!subscribing}
                >
                  <View style={styles.saveBadge}>
                    <Text style={styles.saveBadgeText}>Save 14%</Text>
                  </View>
                  {subscribing === "yearly" ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <View style={styles.planInfo}>
                        <Text style={[styles.planName, { color: "#fff" }]}>
                          Yearly
                        </Text>
                        <Text
                          style={[
                            styles.planDesc,
                            { color: "rgba(255,255,255,0.7)" },
                          ]}
                        >
                          Billed once a year
                        </Text>
                      </View>
                      <Text style={[styles.planPrice, { color: "#fff" }]}>
                        KES 1,350
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {status?.isSubscribed &&
              status.plan !== "free" &&
              status.expiresAt && (
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={handleCancel}
                  disabled={cancelling}
                >
                  {cancelling ? (
                    <ActivityIndicator size="small" color="#ff4444" />
                  ) : (
                    <Text style={styles.cancelButtonText}>
                      Cancel subscription
                    </Text>
                  )}
                </TouchableOpacity>
              )}

            {/* Footer note */}
            <Text style={styles.footerNote}>
              Payments are processed securely.{"\n"}
              Cancel anytime — access continues until period ends.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f5f5f5" },

  // ── Header ────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 16,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  backButton: { width: 36 },
  headerTitle: { fontSize: 17, fontWeight: "700", color: "#111" },

  // ── Content ───────────────────────────────────────────────
  content: {
    padding: 16,
    paddingBottom: 48,
    gap: 16,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 80,
  },

  // ── Status card ───────────────────────────────────────────
  statusCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#eee",
  },
  statusIconRow: { marginBottom: 8 },
  statusIcon: { fontSize: 40 },
  statusTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#111",
    marginBottom: 4,
  },
  statusSubtitle: {
    fontSize: 14,
    color: "#666",
    marginBottom: 12,
  },
  renewalBadge: {
    backgroundColor: "rgba(74,232,160,0.15)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(74,232,160,0.4)",
  },
  renewalText: {
    fontSize: 12,
    color: "#2a9d6e",
    fontWeight: "600",
  },

  // ── Comparison card ───────────────────────────────────────
  comparisonCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "#eee",
  },
  comparisonTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111",
    marginBottom: 16,
  },
  featureHeader: {
    flexDirection: "row",
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  featureHeaderSpacer: { flex: 1 },
  featureHeaderLabels: {
    flexDirection: "row",
    gap: 24,
  },
  featureHeaderFree: {
    fontSize: 12,
    fontWeight: "600",
    color: "#999",
    width: 70,
    textAlign: "center",
  },
  featureHeaderPro: {
    fontSize: 12,
    fontWeight: "700",
    color: "#111",
    width: 70,
    textAlign: "center",
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#f5f5f5",
  },
  featureIcon: { marginRight: 10 },
  featureLabel: { flex: 1, fontSize: 14, color: "#333" },
  featureValues: {
    flexDirection: "row",
    gap: 24,
  },
  featureFree: {
    fontSize: 13,
    color: "#999",
    width: 70,
    textAlign: "center",
  },
  featurePro: {
    fontSize: 13,
    fontWeight: "600",
    color: "#111",
    width: 70,
    textAlign: "center",
  },

  // ── Plans ─────────────────────────────────────────────────
  plansSection: { gap: 12 },
  plansTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111",
    marginBottom: 4,
  },
  planCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "#eee",
    position: "relative",
  },
  planCardFeatured: {
    backgroundColor: "#111",
    borderColor: "#111",
  },
  planInfo: { gap: 4 },
  planName: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111",
  },
  planDesc: {
    fontSize: 13,
    color: "#999",
  },
  planPrice: {
    fontSize: 18,
    fontWeight: "800",
    color: "#111",
  },
  saveBadge: {
    position: "absolute",
    top: -10,
    right: 16,
    backgroundColor: "#4AE8A0",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  saveBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#111",
  },

  // ── Footer ────────────────────────────────────────────────
  footerNote: {
    fontSize: 12,
    color: "#999",
    textAlign: "center",
    lineHeight: 18,
    marginTop: 8,
  },
  cancelButton: {
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  cancelButtonText: {
    fontSize: 13,
    color: "#ff4444",
    textDecorationLine: "underline",
  },
});
