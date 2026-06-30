import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { supabase } from "../utils/supabase";

const SCREEN_WIDTH = Dimensions.get("window").width;
const IS_WEB = Platform.OS === "web";

type Tier = "small" | "medium" | "big";

type TierConfig = {
  label: string;
  emoji: string;
  tagline: string;
  maxCollections: number;
  maxPhotosPerCollection: number;
  price: number;
  accent: string;
  bg: string;
  featured: boolean;
};

const TIERS: Record<Tier, TierConfig> = {
  small: {
    label: "Small",
    emoji: "📗",
    tagline: "For individuals & small families",
    maxCollections: 15,
    maxPhotosPerCollection: 35,
    price: 99,
    accent: "#22c55e",
    bg: "#f0fdf4",
    featured: false,
  },
  medium: {
    label: "Medium",
    emoji: "📘",
    tagline: "For growing families",
    maxCollections: 30,
    maxPhotosPerCollection: 50,
    price: 179,
    accent: "#3b82f6",
    bg: "#eff6ff",
    featured: true,
  },
  big: {
    label: "Big",
    emoji: "📙",
    tagline: "The complete family archive",
    maxCollections: 50,
    maxPhotosPerCollection: 75,
    price: 299,
    accent: "#f59e0b",
    bg: "#fffbeb",
    featured: false,
  },
};

type PaywallReason = "collections" | "photos";

type Props = {
  visible: boolean;
  reason: PaywallReason;
  // The exact limit the user just hit — e.g. 3 collections or 10 photos
  currentLimit?: number;
  // The tier they are currently on — "free" or a paid tier
  currentTier?: "free" | "small" | "medium" | "big";
  onSubscribed: (tier: Tier) => void;
  onDismiss: () => void;
};

// Whether a tier actually solves the user's current limit
function doesSolve(
  tier: Tier,
  reason: PaywallReason,
  currentLimit: number,
): boolean {
  const config = TIERS[tier];
  return reason === "collections"
    ? config.maxCollections > currentLimit
    : config.maxPhotosPerCollection > currentLimit;
}

// The smallest tier that solves the limit — highlighted as recommended
function recommendedTier(reason: PaywallReason, currentLimit: number): Tier {
  const all: Tier[] = ["small", "medium", "big"];
  for (const tier of all) {
    if (doesSolve(tier, reason, currentLimit)) return tier;
  }
  return "big";
}

export default function PaywallModal({
  visible,
  reason,
  currentLimit,
  currentTier = "free",
  onSubscribed,
  onDismiss,
}: Props) {
  const router = useRouter();
  const [purchasing, setPurchasing] = useState<Tier | null>(null);
  const slideAnim = useRef(new Animated.Value(300)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Default limits if not passed
  const limit = currentLimit ?? (reason === "collections" ? 3 : 10);
  const recommended = recommendedTier(reason, limit);
  const ALL_PAID_TIERS: Tier[] = ["small", "medium", "big"];

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.spring(slideAnim, {
          toValue: 0,
          tension: 65,
          friction: 11,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      // Animate out first, THEN unmount — prevents instant disappear
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 300,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start(() => setMounted(false));
    }
  }, [visible]);

  if (!mounted && !visible) return null;

  // Dynamic headline based on exactly what the user hit
  const emoji = reason === "collections" ? "🗂️" : "📸";

  const title =
    reason === "collections"
      ? `You've used all ${limit} collection${limit === 1 ? "" : "s"}`
      : `You've reached the ${limit} photo limit`;

  const sub =
    reason === "collections"
      ? `Your ${currentTier === "free" ? "free" : (TIERS[currentTier as Tier]?.label ?? "")} plan allows ${limit} collection${limit === 1 ? "" : "s"}. Upgrade to store more memories.`
      : `Your ${currentTier === "free" ? "free" : (TIERS[currentTier as Tier]?.label ?? "")} plan allows ${limit} photos per collection. Upgrade to keep adding moments.`;

  const recommendedConfig = TIERS[recommended];

  // What the recommended upgrade unlocks
  const unlockText =
    reason === "collections"
      ? `${recommendedConfig.maxCollections} collections`
      : `${recommendedConfig.maxPhotosPerCollection} photos per collection`;

  async function handlePurchase(tier: Tier) {
    // ── Guest check ───────────────────────────────────────
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      onDismiss();
      router.push("/login?redirect=subscription");
      return;
    }

    setPurchasing(tier);

    try {
      const callbackUrl = IS_WEB
        ? `${window.location.origin}/subscription-callback`
        : "mems://subscription-callback";

      if (IS_WEB) {
        // ── Web — open Pesapal popup immediately on tap ───
        // Must be opened synchronously before any await or mobile
        // browsers will block it as an untrusted popup
        const popup = window.open(
          "",
          "pesapal",
          "width=620,height=720,left=200,top=80",
        );

        if (!popup) {
          // Popup blocked — fall back to same-tab redirect
          const { data, error } = await supabase.functions.invoke(
            "create-subscription",
            { body: { tier, callbackUrl } },
          );
          if (error) throw new Error(error.message);
          window.location.href = data.redirectUrl;
          return;
        }

        // Show branded loading screen while we fetch the URL
        popup.document.write(`
          <html><body style="display:flex;align-items:center;justify-content:center;
          height:100vh;font-family:sans-serif;background:#f9f9f9;flex-direction:column;gap:16px">
          <div style="font-size:48px">📸</div>
          <div style="font-size:18px;font-weight:600;color:#111">Opening secure payment...</div>
          <div style="font-size:13px;color:#999">Please wait a moment</div>
          </body></html>
        `);

        const { data, error } = await supabase.functions.invoke(
          "create-subscription",
          { body: { tier, callbackUrl } },
        );

        if (error) {
          popup.close();
          throw new Error(error.message);
        }

        const { redirectUrl, merchantReference } = data;
        popup.location.href = redirectUrl;

        // Poll for popup close then sync payment status
        const poll = setInterval(async () => {
          if (popup?.closed) {
            clearInterval(poll);
            try {
              const { data: sync } = await supabase.functions.invoke(
                "sync-subscription",
                { body: { merchantReference, tier } },
              );
              if (sync?.status === "active") {
                try {
                  popup.close();
                } catch {}
                onSubscribed(tier);
              } else {
                onDismiss();
              }
            } catch {
              onDismiss();
            } finally {
              setPurchasing(null);
            }
          }
        }, 1000);
      } else {
        // ── Native — open Pesapal in in-app browser directly ──
        // No navigation away from the current screen
        const { data, error } = await supabase.functions.invoke(
          "create-subscription",
          { body: { tier, callbackUrl } },
        );

        if (error) throw new Error(error.message);

        const { redirectUrl, merchantReference } = data;

        // Open Pesapal in the in-app browser — user stays in context
        const result = await WebBrowser.openBrowserAsync(redirectUrl, {
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.FORM_SHEET,
          toolbarColor: "#111",
          controlsColor: "#fff",
        });

        // Browser closed — check payment status regardless of result type
        // (user may have completed or abandoned payment)
        try {
          const { data: sync } = await supabase.functions.invoke(
            "sync-subscription",
            { body: { merchantReference, tier } },
          );

          if (sync?.status === "active") {
            // Payment confirmed — resume blocked action
            onSubscribed(tier);
          } else {
            // Payment not completed — cancel and let user try again
            onDismiss();
          }
        } catch {
          onDismiss();
        } finally {
          setPurchasing(null);
        }
      }
    } catch (err: any) {
      if (IS_WEB) {
        window.alert("Payment error: " + err.message);
      } else {
        Alert.alert("Payment error", err.message);
      }
      setPurchasing(null);
    }
  }

  if (!visible) return null;

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onDismiss}
    >
      {/* Backdrop */}
      <Animated.View style={[styles.backdrop, { opacity: fadeAnim }]}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          onPress={onDismiss}
          activeOpacity={1}
        />
      </Animated.View>

      {/* Sheet */}
      <Animated.View
        style={[styles.sheet, { transform: [{ translateY: slideAnim }] }]}
      >
        {/* Handle */}
        <View style={styles.handle} />

        {/* Dismiss */}
        <TouchableOpacity
          style={styles.closeButton}
          onPress={onDismiss}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="close" size={20} color="#999" />
        </TouchableOpacity>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
        >
          {/* Header */}
          <Text style={styles.headerEmoji}>{emoji}</Text>
          <Text style={styles.headerTitle}>{title}</Text>
          <Text style={styles.headerSub}>{sub}</Text>

          {/* Dynamic limit reached banner */}
          <View
            style={[
              styles.limitBanner,
              {
                borderColor: `${recommendedConfig.accent}40`,
                backgroundColor: `${recommendedConfig.accent}0d`,
              },
            ]}
          >
            <View style={styles.limitBannerLeft}>
              <Text style={styles.limitBannerEmoji}>
                {currentTier === "free"
                  ? "📓"
                  : (TIERS[currentTier as Tier]?.emoji ?? "📓")}
              </Text>
              <View>
                <Text style={styles.limitBannerLabel}>
                  {currentTier === "free"
                    ? "Free"
                    : (TIERS[currentTier as Tier]?.label ?? "Free")}{" "}
                  plan limit
                </Text>
                <Text style={styles.limitBannerValue}>
                  {reason === "collections"
                    ? `${limit} collection${limit === 1 ? "" : "s"} used`
                    : `${limit} photos per collection`}
                </Text>
              </View>
            </View>
            <Ionicons
              name="arrow-forward"
              size={16}
              color={recommendedConfig.accent}
            />
            <View>
              <Text
                style={[
                  styles.limitBannerUpgrade,
                  { color: recommendedConfig.accent },
                ]}
              >
                {recommendedConfig.emoji} {recommendedConfig.label}
              </Text>
              <Text
                style={[
                  styles.limitBannerUnlock,
                  { color: recommendedConfig.accent },
                ]}
              >
                {unlockText}
              </Text>
            </View>
          </View>

          {/* Tier cards — all three shown, insufficient ones greyed out */}
          <Text style={styles.sectionTitle}>Choose your upgrade</Text>

          {ALL_PAID_TIERS.map((tier) => {
            const config = TIERS[tier];
            const isPurchasing = purchasing === tier;
            const isRecommended = tier === recommended;
            const solves = doesSolve(tier, reason, limit);
            const isGreyed = !solves;

            return (
              <TouchableOpacity
                key={tier}
                style={[
                  styles.tierCard,
                  isGreyed && styles.tierCardGreyed,
                  !isGreyed && isRecommended && styles.tierCardRecommended,
                  !isGreyed && {
                    borderColor: isRecommended ? config.accent : "#e0e0e0",
                  },
                  isPurchasing && { opacity: 0.7 },
                ]}
                onPress={() => !isGreyed && handlePurchase(tier)}
                disabled={!!purchasing || isGreyed}
                activeOpacity={isGreyed ? 1 : 0.85}
              >
                {/* Badge row */}
                {isGreyed ? (
                  <View style={styles.greyedBadge}>
                    <Text style={styles.greyedBadgeText}>
                      Too small for your current usage
                    </Text>
                  </View>
                ) : isRecommended ? (
                  <View
                    style={[
                      styles.popularBadge,
                      { backgroundColor: config.accent },
                    ]}
                  >
                    <Text style={styles.popularBadgeText}>
                      ✦ Recommended for you
                    </Text>
                  </View>
                ) : null}

                <View
                  style={[styles.tierLeft, isGreyed && styles.tierLeftGreyed]}
                >
                  <Text
                    style={[styles.tierEmoji, isGreyed && { opacity: 0.35 }]}
                  >
                    {config.emoji}
                  </Text>
                  <View style={styles.tierInfo}>
                    <Text
                      style={[styles.tierLabel, isGreyed && styles.greyedText]}
                    >
                      {config.label} Album
                    </Text>
                    <Text
                      style={[
                        styles.tierTagline,
                        isGreyed && styles.greyedSubText,
                      ]}
                    >
                      {config.tagline}
                    </Text>
                    <View style={styles.tierStats}>
                      {/* Collections stat */}
                      <View
                        style={[
                          styles.tierStat,
                          isGreyed
                            ? styles.tierStatGreyed
                            : { backgroundColor: `${config.accent}18` },
                          !isGreyed &&
                            reason === "collections" &&
                            isRecommended &&
                            styles.tierStatHighlight,
                        ]}
                      >
                        <Text
                          style={[
                            styles.tierStatText,
                            isGreyed
                              ? styles.greyedStatText
                              : { color: config.accent },
                          ]}
                        >
                          {config.maxCollections} collections
                        </Text>
                      </View>
                      {/* Photos stat */}
                      <View
                        style={[
                          styles.tierStat,
                          isGreyed
                            ? styles.tierStatGreyed
                            : { backgroundColor: `${config.accent}18` },
                          !isGreyed &&
                            reason === "photos" &&
                            isRecommended &&
                            styles.tierStatHighlight,
                        ]}
                      >
                        <Text
                          style={[
                            styles.tierStatText,
                            isGreyed
                              ? styles.greyedStatText
                              : { color: config.accent },
                          ]}
                        >
                          {config.maxPhotosPerCollection} photos each
                        </Text>
                      </View>
                    </View>
                  </View>
                </View>

                <View style={styles.tierRight}>
                  {isPurchasing ? (
                    <ActivityIndicator color={config.accent} size="small" />
                  ) : isGreyed ? (
                    <View style={styles.greyedPriceBlock}>
                      <Text style={styles.greyedPrice}>
                        KES {config.price.toLocaleString()}
                      </Text>
                      <Text style={styles.greyedOnce}>once</Text>
                    </View>
                  ) : (
                    <>
                      <Text
                        style={[styles.tierPrice, { color: config.accent }]}
                      >
                        KES {config.price.toLocaleString()}
                      </Text>
                      <Text style={styles.tierOnce}>/mo</Text>
                      <View
                        style={[
                          styles.tierButton,
                          {
                            backgroundColor: isRecommended
                              ? config.accent
                              : "#efefef",
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.tierButtonText,
                            !isRecommended && { color: "#666" },
                          ]}
                        >
                          {isRecommended ? "Upgrade" : "Get"}
                        </Text>
                      </View>
                    </>
                  )}
                </View>
              </TouchableOpacity>
            );
          })}

          {/* Maybe Later */}
          <TouchableOpacity style={styles.laterButton} onPress={onDismiss}>
            <Text style={styles.laterText}>Maybe Later</Text>
          </TouchableOpacity>

          <Text style={styles.footer}>
            Billed monthly · Cancel anytime · Secure via Pesapal
          </Text>
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#fff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: "90%",
    paddingBottom: Platform.OS === "ios" ? 34 : 24,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.12,
        shadowRadius: 16,
      },
      android: { elevation: 20 },
      web: { boxShadow: "0 -8px 32px rgba(0,0,0,0.12)" } as any,
    }),
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#e0e0e0",
    alignSelf: "center",
    marginTop: 12,
    marginBottom: 4,
  },
  closeButton: {
    position: "absolute",
    top: 16,
    right: 20,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#f5f5f5",
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    padding: 24,
    paddingTop: 12,
    gap: 12,
  },

  // Header
  headerEmoji: { fontSize: 48, textAlign: "center", marginTop: 8 },
  headerTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#111",
    textAlign: "center",
    lineHeight: 26,
    marginTop: 8,
  },
  headerSub: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 4,
  },

  // Limit reached banner
  limitBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 4,
  },
  limitBannerLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  limitBannerEmoji: { fontSize: 24 },
  limitBannerLabel: { fontSize: 11, color: "#999", fontWeight: "600" },
  limitBannerValue: {
    fontSize: 13,
    color: "#555",
    fontWeight: "700",
    marginTop: 1,
  },
  limitBannerUpgrade: { fontSize: 13, fontWeight: "800", textAlign: "right" },
  limitBannerUnlock: {
    fontSize: 11,
    fontWeight: "500",
    textAlign: "right",
    marginTop: 1,
  },

  tierCardRecommended: {
    ...Platform.select({
      ios: {
        shadowColor: "#3b82f6",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
      android: { elevation: 6 },
      web: { boxShadow: "0 4px 20px rgba(59,130,246,0.15)" } as any,
    }),
  },
  // Greyed out — not a valid upgrade for current usage
  tierCardGreyed: {
    borderColor: "#ececec",
    backgroundColor: "#fafafa",
    opacity: 0.6,
  },
  tierLeftGreyed: { opacity: 0.5 },
  greyedText: { color: "#bbb" },
  greyedSubText: { color: "#ccc" },
  greyedBadge: {
    backgroundColor: "#f0f0f0",
    paddingVertical: 4,
    paddingHorizontal: 10,
    alignSelf: "flex-start",
    borderRadius: 6,
    marginBottom: 6,
  },
  greyedBadgeText: { fontSize: 10, color: "#bbb", fontWeight: "600" },
  tierStatGreyed: { backgroundColor: "#f0f0f0" },
  greyedStatText: { color: "#ccc" },
  greyedPriceBlock: { alignItems: "flex-end", gap: 2 },
  greyedPrice: { fontSize: 14, fontWeight: "700", color: "#ccc" },
  greyedOnce: { fontSize: 10, color: "#ddd" },
  tierStatHighlight: {
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },

  // Section title
  sectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111",
    marginTop: 4,
    marginBottom: 4,
  },

  // Tier cards
  tierCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 16,
    borderWidth: 1.5,
    padding: 16,
    position: "relative",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 8,
      },
      android: { elevation: 2 },
      web: { boxShadow: "0 2px 12px rgba(0,0,0,0.06)" } as any,
    }),
  },
  tierCardFeatured: {
    ...Platform.select({
      ios: {
        shadowColor: "#3b82f6",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
      android: { elevation: 6 },
      web: { boxShadow: "0 4px 20px rgba(59,130,246,0.15)" } as any,
    }),
  },
  popularBadge: {
    position: "absolute",
    top: -10,
    left: 16,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
  },
  popularBadgeText: { fontSize: 10, fontWeight: "700", color: "#fff" },

  tierLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  tierEmoji: { fontSize: 28, marginTop: 2 },
  tierInfo: { flex: 1 },
  tierLabel: {
    fontSize: 15,
    fontWeight: "800",
    color: "#111",
    marginBottom: 2,
  },
  tierTagline: { fontSize: 12, color: "#888", marginBottom: 8 },
  tierStats: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  tierStat: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  tierStatText: { fontSize: 11, fontWeight: "600" },

  tierRight: { alignItems: "flex-end", gap: 4, minWidth: 72 },
  tierPrice: { fontSize: 16, fontWeight: "900" },
  tierOnce: { fontSize: 10, color: "#bbb", marginTop: -2 },
  tierButton: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    marginTop: 4,
  },
  tierButtonText: { fontSize: 13, fontWeight: "700", color: "#fff" },

  // Footer
  laterButton: { alignItems: "center", paddingVertical: 12 },
  laterText: { fontSize: 14, color: "#bbb", fontWeight: "500" },
  footer: {
    fontSize: 11,
    color: "#ccc",
    textAlign: "center",
    lineHeight: 16,
  },
});
