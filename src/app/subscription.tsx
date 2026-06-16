import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
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
// Use desktop layout only when screen is wide enough — mobile browsers get the toggle
const IS_DESKTOP = IS_WEB && SCREEN_WIDTH >= 768;
const CARD_WIDTH = IS_DESKTOP
  ? Math.min(260, (Math.min(SCREEN_WIDTH, 900) - 80) / 3)
  : SCREEN_WIDTH - 48;

// Re-evaluate on window resize (handles mobile browser orientation changes)
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(IS_DESKTOP);
  useEffect(() => {
    if (!IS_WEB) return;
    const handler = () => setIsDesktop(window.innerWidth >= 768);
    window.addEventListener("resize", handler);
    handler(); // run immediately in case already resized
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isDesktop;
}

type Tier = "free" | "small" | "medium" | "big";
type PaidTier = Exclude<Tier, "free">;

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

const TIERS: Record<PaidTier, TierConfig> = {
  small: {
    label: "Small",
    emoji: "📗",
    tagline: "For individuals & small families",
    maxCollections: 15,
    maxPhotosPerCollection: 35,
    price: 320,
    accent: "#22c55e",
    bg: "#f0fdf4",
    featured: false,
  },
  medium: {
    label: "Medium",
    emoji: "📘",
    tagline: "For growing families with lots of memories",
    maxCollections: 30,
    maxPhotosPerCollection: 50,
    price: 600,
    accent: "#3b82f6",
    bg: "#eff6ff",
    featured: true,
  },
  big: {
    label: "Big",
    emoji: "📙",
    tagline: "The complete family archive, for generations",
    maxCollections: 50,
    maxPhotosPerCollection: 75,
    price: 1150,
    accent: "#f59e0b",
    bg: "#fffbeb",
    featured: false,
  },
};

const FEATURES: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  key: string;
  label: string;
}[] = [
  { icon: "albums-outline", key: "collections", label: "Collections" },
  { icon: "images-outline", key: "photos", label: "Photos each" },
  { icon: "share-outline", key: "share", label: "Share albums" },
  { icon: "cloud-done-outline", key: "cloud", label: "Cloud storage" },
  { icon: "infinite-outline", key: "forever", label: "Yours forever" },
  { icon: "people-outline", key: "multi", label: "Multi-user add" },
];

type SubStatus = {
  tier: Tier;
  isActive: boolean;
  limits: { maxCollections: number; maxPhotosPerCollection: number };
};

function featureValue(tier: PaidTier, key: string): string {
  switch (key) {
    case "collections":
      return `${TIERS[tier].maxCollections}`;
    case "photos":
      return `${TIERS[tier].maxPhotosPerCollection}`;
    default:
      return "✓";
  }
}

export default function SubscriptionPage() {
  const router = useRouter();
  const isDesktop = useIsDesktop(); // ← responsive to resize
  const [status, setStatus] = useState<SubStatus | null>(null);
  const cardWidth = isDesktop
    ? Math.min(260, (Math.min(SCREEN_WIDTH, 900) - 80) / 3)
    : SCREEN_WIDTH - 48;
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<Tier | null>(null);
  // Mobile-only: which tier is selected in the toggle
  const [selectedTier, setSelectedTier] = useState<PaidTier>("medium");

  // Animated underline for mobile toggle
  const toggleAnim = useRef(new Animated.Value(1)).current; // 0=small 1=medium 2=big
  // Pulse for featured
  const pulseAnim = useRef(new Animated.Value(1)).current;
  // Card fade for tier switch
  const cardFade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.012,
          duration: 2000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 2000,
          useNativeDriver: true,
        }),
      ]),
    ).start();
  }, []);

  useEffect(() => {
    supabase.functions
      .invoke("check-subscription")
      .then(({ data }) => {
        setStatus({
          tier: data?.tier ?? "free",
          isActive: data?.isActive ?? false,
          limits: data?.limits ?? {
            maxCollections: 3,
            maxPhotosPerCollection: 10,
          },
        });
      })
      .finally(() => setLoading(false));
  }, []);

  function switchTier(tier: PaidTier) {
    // Fade out → switch → fade in
    Animated.timing(cardFade, {
      toValue: 0,
      duration: 120,
      useNativeDriver: true,
    }).start(() => {
      setSelectedTier(tier);
      const idx = (["small", "medium", "big"] as PaidTier[]).indexOf(tier);
      Animated.timing(toggleAnim, {
        toValue: idx,
        duration: 200,
        useNativeDriver: false,
      }).start();
      Animated.timing(cardFade, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }).start();
    });
  }

  async function handlePurchase(tier: PaidTier) {
    if (status?.isActive && status.tier === tier) {
      const msg = "You already have this album.";
      IS_WEB ? window.alert(msg) : Alert.alert("Already active", msg);
      return;
    }
    setPurchasing(tier);
    try {
      const callbackUrl = IS_WEB
        ? `${window.location.origin}/subscription-callback`
        : "mems://subscription-callback";

      const { data, error } = await supabase.functions.invoke(
        "create-subscription",
        {
          body: { tier, callbackUrl },
        },
      );
      if (error) throw new Error(error.message);

      if (IS_WEB) {
        const popup = window.open(
          data.redirectUrl,
          "pesapal",
          "width=620,height=720,left=200,top=80",
        );
        const poll = setInterval(async () => {
          if (popup?.closed) {
            clearInterval(poll);
            const { data: sync } =
              await supabase.functions.invoke("sync-subscription");
            if (sync?.status === "active") {
              const { data: updated } =
                await supabase.functions.invoke("check-subscription");
              setStatus({
                tier: updated?.tier ?? tier,
                isActive: true,
                limits: updated?.limits ?? TIERS[tier],
              });
              window.alert(`🎉 ${TIERS[tier].label} Album activated!`);
            }
            setPurchasing(null);
          }
        }, 1000);
      }
    } catch (err: any) {
      IS_WEB
        ? window.alert("Error: " + err.message)
        : Alert.alert("Error", err.message);
      setPurchasing(null);
    }
  }

  const activeTier = status?.isActive ? (status.tier as PaidTier) : null;
  const tiers: PaidTier[] = ["small", "medium", "big"];

  // Pill position interpolation for mobile toggle
  const pillLeft = toggleAnim.interpolate({
    inputRange: [0, 1, 2],
    outputRange: ["0%", "33.33%", "66.66%"],
  });

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Album Plans</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.page}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <Text style={styles.heroTitle}>Your life's best moments</Text>
          <Text style={styles.heroSub}>
            One-time payment · No subscriptions · Yours forever
          </Text>
        </View>

        {/* Active plan pill */}
        {status?.isActive && activeTier && (
          <View
            style={[
              styles.activePill,
              { backgroundColor: TIERS[activeTier].accent },
            ]}
          >
            <Ionicons name="checkmark-circle" size={14} color="#fff" />
            <Text style={styles.activePillText}>
              {TIERS[activeTier].emoji} {TIERS[activeTier].label} Album is
              active
            </Text>
          </View>
        )}

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color="#111" />
          </View>
        ) : isDesktop ? (
          /* ══════════════════════════════════════════
             WEB — three cards side by side
          ══════════════════════════════════════════ */
          <>
            <View style={styles.webCardRow}>
              {tiers.map((tier) => {
                const config = TIERS[tier];
                const isActive = activeTier === tier;
                const isFeatured = config.featured;
                const isPurchasing = purchasing === tier;

                const cardStyle = [
                  styles.webCard,
                  { width: cardWidth },
                  isFeatured && styles.webCardFeatured,
                  isActive && { borderColor: config.accent, borderWidth: 2 },
                ];

                const CardEl = isFeatured ? Animated.View : View;

                return (
                  <CardEl
                    key={tier}
                    style={
                      isFeatured
                        ? [cardStyle, { transform: [{ scale: pulseAnim }] }]
                        : cardStyle
                    }
                  >
                    {isFeatured && (
                      <View
                        style={[
                          styles.webCardBadge,
                          { backgroundColor: config.accent },
                        ]}
                      >
                        <Text style={styles.webCardBadgeText}>
                          ⭐ Most Popular
                        </Text>
                      </View>
                    )}
                    {isActive && (
                      <View
                        style={[
                          styles.webCardBadge,
                          { backgroundColor: config.accent },
                        ]}
                      >
                        <Text style={styles.webCardBadgeText}>✓ Your Plan</Text>
                      </View>
                    )}

                    <View
                      style={[
                        styles.webCardTop,
                        { backgroundColor: config.bg },
                      ]}
                    >
                      <Text style={styles.webCardEmoji}>{config.emoji}</Text>
                      <Text style={styles.webCardLabel}>{config.label}</Text>
                      <Text style={styles.webCardTagline}>
                        {config.tagline}
                      </Text>
                    </View>

                    <View style={styles.webCardStats}>
                      <View style={styles.webCardStat}>
                        <Text
                          style={[
                            styles.webCardStatValue,
                            { color: config.accent },
                          ]}
                        >
                          {config.maxCollections}
                        </Text>
                        <Text style={styles.webCardStatLabel}>Albums</Text>
                      </View>
                      <View style={styles.webCardStatDivider} />
                      <View style={styles.webCardStat}>
                        <Text
                          style={[
                            styles.webCardStatValue,
                            { color: config.accent },
                          ]}
                        >
                          {config.maxPhotosPerCollection}
                        </Text>
                        <Text style={styles.webCardStatLabel}>Photos each</Text>
                      </View>
                    </View>

                    <View style={styles.webCardPricing}>
                      <Text style={styles.webCardCurrency}>KES</Text>
                      <Text
                        style={[styles.webCardPrice, { color: config.accent }]}
                      >
                        {config.price.toLocaleString()}
                      </Text>
                      <Text style={styles.webCardOnce}>once</Text>
                    </View>

                    <TouchableOpacity
                      style={[
                        styles.webCardButton,
                        {
                          backgroundColor: isActive
                            ? "transparent"
                            : config.accent,
                        },
                        isActive && {
                          borderWidth: 2,
                          borderColor: config.accent,
                        },
                        isPurchasing && { opacity: 0.7 },
                      ]}
                      onPress={() => handlePurchase(tier)}
                      disabled={!!purchasing || isActive}
                      activeOpacity={0.8}
                    >
                      {isPurchasing ? (
                        <ActivityIndicator
                          color={isActive ? config.accent : "#fff"}
                          size="small"
                        />
                      ) : (
                        <Text
                          style={[
                            styles.webCardButtonText,
                            isActive && { color: config.accent },
                          ]}
                        >
                          {isActive ? "✓ Active" : "Get this album"}
                        </Text>
                      )}
                    </TouchableOpacity>
                  </CardEl>
                );
              })}
            </View>

            {/* Web comparison table */}
            <ComparisonTable
              tiers={tiers}
              activeTier={activeTier}
              tableWidth={Math.min(860, SCREEN_WIDTH - 48)}
            />
          </>
        ) : (
          /* ══════════════════════════════════════════
             MOBILE — segmented toggle + single card
          ══════════════════════════════════════════ */
          <>
            {/* Three-way pill toggle */}
            <View style={styles.toggleWrapper}>
              <View style={styles.toggleTrack}>
                {/* Animated sliding pill */}
                <Animated.View
                  style={[styles.togglePill, { left: pillLeft }]}
                  pointerEvents="none"
                />
                {tiers.map((tier) => {
                  const config = TIERS[tier];
                  const isSelected = selectedTier === tier;
                  return (
                    <TouchableOpacity
                      key={tier}
                      style={styles.toggleOption}
                      onPress={() => switchTier(tier)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.toggleEmoji}>{config.emoji}</Text>
                      <Text
                        style={[
                          styles.toggleLabel,
                          isSelected && { color: "#111", fontWeight: "700" },
                        ]}
                      >
                        {config.label}
                      </Text>
                      {activeTier === tier && (
                        <View
                          style={[
                            styles.toggleDot,
                            { backgroundColor: config.accent },
                          ]}
                        />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Single animated card */}
            <Animated.View
              style={[
                styles.mobileCard,
                { opacity: cardFade, width: cardWidth },
              ]}
            >
              {(() => {
                const config = TIERS[selectedTier];
                const isActive = activeTier === selectedTier;
                const isPurchasing = purchasing === selectedTier;

                return (
                  <>
                    {/* Card header */}
                    <View
                      style={[
                        styles.mobileCardHeader,
                        { backgroundColor: config.bg },
                      ]}
                    >
                      {config.featured && !isActive && (
                        <View
                          style={[
                            styles.mobileCardBadge,
                            { backgroundColor: config.accent },
                          ]}
                        >
                          <Text style={styles.mobileCardBadgeText}>
                            ⭐ Most Popular
                          </Text>
                        </View>
                      )}
                      {isActive && (
                        <View
                          style={[
                            styles.mobileCardBadge,
                            { backgroundColor: config.accent },
                          ]}
                        >
                          <Text style={styles.mobileCardBadgeText}>
                            ✓ Your Plan
                          </Text>
                        </View>
                      )}
                      <Text style={styles.mobileCardEmoji}>{config.emoji}</Text>
                      <Text style={styles.mobileCardLabel}>
                        {config.label} Album
                      </Text>
                      <Text style={styles.mobileCardTagline}>
                        {config.tagline}
                      </Text>
                    </View>

                    {/* Stats row */}
                    <View style={styles.mobileCardStats}>
                      <View style={styles.mobileCardStat}>
                        <Text
                          style={[
                            styles.mobileStatValue,
                            { color: config.accent },
                          ]}
                        >
                          {config.maxCollections}
                        </Text>
                        <Text style={styles.mobileStatLabel}>Collections</Text>
                      </View>
                      <View style={styles.mobileCardStatDivider} />
                      <View style={styles.mobileCardStat}>
                        <Text
                          style={[
                            styles.mobileStatValue,
                            { color: config.accent },
                          ]}
                        >
                          {config.maxPhotosPerCollection}
                        </Text>
                        <Text style={styles.mobileStatLabel}>Photos each</Text>
                      </View>
                      <View style={styles.mobileCardStatDivider} />
                      <View style={styles.mobileCardStat}>
                        <Text
                          style={[
                            styles.mobileStatValue,
                            { color: config.accent },
                          ]}
                        >
                          KES {config.price.toLocaleString()}
                        </Text>
                        <Text style={styles.mobileStatLabel}>One-time</Text>
                      </View>
                    </View>

                    {/* Features list */}
                    <View style={styles.mobileFeatures}>
                      {[
                        `${config.maxCollections} collections`,
                        `${config.maxPhotosPerCollection} photos per collection`,
                        "Share with family & friends",
                        "Secure cloud storage",
                        "Yours forever — no renewals",
                        "Multi-user uploads",
                      ].map((feat) => (
                        <View key={feat} style={styles.mobileFeatureRow}>
                          <View
                            style={[
                              styles.mobileFeatureDot,
                              { backgroundColor: config.accent },
                            ]}
                          />
                          <Text style={styles.mobileFeatureText}>{feat}</Text>
                        </View>
                      ))}
                    </View>

                    {/* CTA */}
                    <TouchableOpacity
                      style={[
                        styles.mobileCardButton,
                        {
                          backgroundColor: isActive
                            ? "transparent"
                            : config.accent,
                        },
                        isActive && {
                          borderWidth: 2,
                          borderColor: config.accent,
                        },
                        isPurchasing && { opacity: 0.7 },
                      ]}
                      onPress={() => handlePurchase(selectedTier)}
                      disabled={!!purchasing || isActive}
                      activeOpacity={0.8}
                    >
                      {isPurchasing ? (
                        <ActivityIndicator
                          color={isActive ? config.accent : "#fff"}
                          size="small"
                        />
                      ) : (
                        <>
                          <Text
                            style={[
                              styles.mobileCardButtonText,
                              isActive && { color: config.accent },
                            ]}
                          >
                            {isActive
                              ? "✓ Active plan"
                              : `Get ${config.label} — KES ${config.price.toLocaleString()}`}
                          </Text>
                          {!isActive && (
                            <Text style={styles.mobileCardButtonSub}>
                              One-time payment
                            </Text>
                          )}
                        </>
                      )}
                    </TouchableOpacity>
                  </>
                );
              })()}
            </Animated.View>

            {/* Mobile comparison table */}
            <ComparisonTable
              tiers={tiers}
              activeTier={activeTier}
              tableWidth={SCREEN_WIDTH - 32}
            />
          </>
        )}

        {/* Footer */}
        <Text style={styles.footer}>
          Payments processed securely by Pesapal.{"\n"}
          Supports M-Pesa, Visa and Mastercard.
        </Text>
      </ScrollView>
    </View>
  );
}

// ── Shared comparison table component ──────────────────────

function ComparisonTable({
  tiers,
  activeTier,
  tableWidth,
}: {
  tiers: PaidTier[];
  activeTier: PaidTier | null;
  tableWidth: number;
}) {
  return (
    <View style={[tableStyles.table, { width: tableWidth }]}>
      <Text style={tableStyles.title}>Compare plans</Text>

      {/* Header row */}
      <View style={tableStyles.row}>
        <View style={tableStyles.featureCol} />
        {tiers.map((tier) => (
          <View key={tier} style={tableStyles.valueCol}>
            <Text style={tableStyles.headerEmoji}>{TIERS[tier].emoji}</Text>
            <Text
              style={[tableStyles.headerLabel, { color: TIERS[tier].accent }]}
            >
              {TIERS[tier].label}
            </Text>
          </View>
        ))}
      </View>

      <View style={tableStyles.divider} />

      {FEATURES.map((feature, i) => (
        <View
          key={feature.key}
          style={[tableStyles.row, i % 2 === 0 && tableStyles.rowAlt]}
        >
          <View style={tableStyles.featureCol}>
            <Ionicons name={feature.icon} size={13} color="#999" />
            <Text style={tableStyles.featureLabel}>{feature.label}</Text>
          </View>
          {tiers.map((tier) => (
            <View key={tier} style={tableStyles.valueCol}>
              <Text
                style={[
                  tableStyles.value,
                  activeTier === tier && {
                    color: TIERS[tier].accent,
                    fontWeight: "700",
                  },
                ]}
              >
                {featureValue(tier, feature.key)}
              </Text>
            </View>
          ))}
        </View>
      ))}

      <View style={tableStyles.divider} />

      {/* Price row */}
      <View style={tableStyles.row}>
        <View style={tableStyles.featureCol}>
          <Ionicons name="pricetag-outline" size={13} color="#999" />
          <Text style={tableStyles.featureLabel}>Price (KES)</Text>
        </View>
        {tiers.map((tier) => (
          <View key={tier} style={tableStyles.valueCol}>
            <Text style={[tableStyles.price, { color: TIERS[tier].accent }]}>
              {TIERS[tier].price.toLocaleString()}
            </Text>
            <Text style={tableStyles.priceSub}>once</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f7f7f9" },

  // ── Header ────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: IS_DESKTOP ? 20 : 56,
    paddingBottom: 16,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: "#111" },

  page: { paddingBottom: 60, alignItems: "center" },
  centered: { paddingTop: 60 },

  // ── Hero ─────────────────────────────────────────────────
  hero: {
    alignItems: "center",
    paddingTop: 28,
    paddingBottom: 16,
    paddingHorizontal: 24,
  },
  heroTitle: {
    fontSize: IS_DESKTOP ? 28 : 22,
    fontWeight: "800",
    color: "#111",
    textAlign: "center",
    letterSpacing: -0.5,
  },
  heroSub: {
    fontSize: 13,
    color: "#888",
    textAlign: "center",
    marginTop: 6,
    lineHeight: 20,
  },

  // ── Active pill ───────────────────────────────────────────
  activePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    marginBottom: 12,
  },
  activePillText: { fontSize: 13, fontWeight: "600", color: "#fff" },

  // ── Web cards ────────────────────────────────────────────
  webCardRow: {
    flexDirection: "row",
    gap: 16,
    paddingHorizontal: 24,
    paddingVertical: 20,
    alignItems: "flex-start",
    justifyContent: "center",
    width: "100%",
  },
  webCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#e8e8e8",
    ...Platform.select({
      web: { boxShadow: "0 4px 20px rgba(0,0,0,0.07)" } as any,
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 12,
      },
      android: { elevation: 4 },
    }),
  },
  webCardFeatured: {
    borderWidth: 2,
    borderColor: "#3b82f6",
    ...Platform.select({
      web: { boxShadow: "0 8px 32px rgba(59,130,246,0.18)" } as any,
      ios: {
        shadowColor: "#3b82f6",
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.2,
        shadowRadius: 16,
      },
      android: { elevation: 8 },
    }),
  },
  webCardBadge: { paddingVertical: 5, alignItems: "center" },
  webCardBadgeText: { fontSize: 11, fontWeight: "700", color: "#fff" },
  webCardTop: { padding: 20, alignItems: "center", gap: 4 },
  webCardEmoji: { fontSize: 34, marginBottom: 4 },
  webCardLabel: { fontSize: 17, fontWeight: "800", color: "#111" },
  webCardTagline: {
    fontSize: 12,
    color: "#666",
    textAlign: "center",
    lineHeight: 17,
    marginTop: 4,
  },
  webCardStats: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#f0f0f0",
  },
  webCardStat: { flex: 1, alignItems: "center", paddingVertical: 14 },
  webCardStatValue: { fontSize: 26, fontWeight: "900" },
  webCardStatLabel: { fontSize: 11, color: "#888", marginTop: 2 },
  webCardStatDivider: { width: 1, backgroundColor: "#f0f0f0" },
  webCardPricing: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    paddingTop: 16,
    paddingBottom: 8,
    gap: 4,
  },
  webCardCurrency: { fontSize: 13, color: "#999", marginBottom: 4 },
  webCardPrice: { fontSize: 30, fontWeight: "900", lineHeight: 34 },
  webCardOnce: { fontSize: 12, color: "#bbb", marginBottom: 4 },
  webCardButton: {
    margin: 16,
    marginTop: 8,
    borderRadius: 12,
    padding: 13,
    alignItems: "center",
  },
  webCardButtonText: { color: "#fff", fontSize: 14, fontWeight: "700" },

  // ── Mobile toggle ─────────────────────────────────────────
  toggleWrapper: { width: SCREEN_WIDTH - 32, marginBottom: 16, marginTop: 4 },
  toggleTrack: {
    flexDirection: "row",
    backgroundColor: "#efefef",
    borderRadius: 14,
    padding: 4,
    position: "relative",
    height: 52,
  },
  togglePill: {
    position: "absolute",
    top: 4,
    width: "33.33%",
    height: 44,
    backgroundColor: "#fff",
    borderRadius: 11,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 6,
      },
      android: { elevation: 3 },
    }),
  },
  toggleOption: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    zIndex: 1,
  },
  toggleEmoji: { fontSize: 16 },
  toggleLabel: { fontSize: 12, color: "#888", fontWeight: "500" },
  toggleDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    position: "absolute",
    bottom: 4,
  },

  // ── Mobile card ───────────────────────────────────────────
  mobileCard: {
    backgroundColor: "#fff",
    borderRadius: 24,
    overflow: "hidden",
    marginBottom: 16,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.1,
        shadowRadius: 16,
      },
      android: { elevation: 6 },
    }),
  },
  mobileCardHeader: { padding: 24, alignItems: "center" },
  mobileCardBadge: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    marginBottom: 12,
  },
  mobileCardBadgeText: { fontSize: 11, fontWeight: "700", color: "#fff" },
  mobileCardEmoji: { fontSize: 48, marginBottom: 8 },
  mobileCardLabel: { fontSize: 22, fontWeight: "800", color: "#111" },
  mobileCardTagline: {
    fontSize: 13,
    color: "#666",
    textAlign: "center",
    marginTop: 6,
    lineHeight: 19,
  },

  mobileCardStats: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#f0f0f0",
  },
  mobileCardStat: { flex: 1, alignItems: "center", paddingVertical: 16 },
  mobileStatValue: { fontSize: 20, fontWeight: "900" },
  mobileStatLabel: { fontSize: 11, color: "#888", marginTop: 3 },
  mobileCardStatDivider: { width: 1, backgroundColor: "#f0f0f0" },

  mobileFeatures: {
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 8,
    gap: 12,
  },
  mobileFeatureRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  mobileFeatureDot: { width: 7, height: 7, borderRadius: 4 },
  mobileFeatureText: { fontSize: 14, color: "#444", lineHeight: 20 },

  mobileCardButton: {
    margin: 20,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  mobileCardButtonText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  mobileCardButtonSub: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 11,
    marginTop: 3,
  },

  // ── Footer ────────────────────────────────────────────────
  footer: {
    fontSize: 12,
    color: "#aaa",
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: 32,
    marginTop: 8,
  },
});

const tableStyles = StyleSheet.create({
  table: {
    backgroundColor: "#fff",
    borderRadius: 16,
    marginHorizontal: 16,
    marginBottom: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#eee",
  },
  title: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111",
    padding: 16,
    paddingBottom: 12,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
    paddingHorizontal: 16,
  },
  rowAlt: { backgroundColor: "#fafafa" },
  featureCol: { flex: 2, flexDirection: "row", alignItems: "center", gap: 7 },
  featureLabel: { fontSize: 13, color: "#555" },
  valueCol: { flex: 1, alignItems: "center", gap: 1 },
  headerEmoji: { fontSize: 18 },
  headerLabel: { fontSize: 12, fontWeight: "700" },
  value: { fontSize: 13, color: "#444", fontWeight: "500" },
  price: { fontSize: 15, fontWeight: "800" },
  priceSub: { fontSize: 10, color: "#999" },
  divider: { height: 1, backgroundColor: "#eee", marginHorizontal: 16 },
});
