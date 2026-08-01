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
const IS_DESKTOP = IS_WEB && SCREEN_WIDTH >= 768;

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(IS_DESKTOP);
  useEffect(() => {
    if (!IS_WEB) return;
    const handler = () => setIsDesktop(window.innerWidth >= 768);
    window.addEventListener("resize", handler);
    handler();
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isDesktop;
}

type Tier = "free" | "small" | "medium" | "big";
type PaidTier = Exclude<Tier, "free">;
type AllTier = Tier;

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

const FREE_TIER: TierConfig = {
  label: "Free",
  emoji: "📓",
  tagline: "Start your memory journey — no payment needed",
  maxCollections: 3,
  maxPhotosPerCollection: 10,
  price: 0,
  accent: "#888",
  bg: "#f5f5f5",
  featured: false,
};

const TIERS: Record<PaidTier, TierConfig> = {
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
    tagline: "For growing families with lots of memories",
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
    tagline: "The complete family archive, for generations",
    maxCollections: 50,
    maxPhotosPerCollection: 75,
    price: 299,
    accent: "#f59e0b",
    bg: "#fffbeb",
    featured: false,
  },
};

const ALL_TIERS: AllTier[] = ["free", "small", "medium", "big"];
const PAID_TIERS: PaidTier[] = ["small", "medium", "big"];

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
  isLapsed: boolean;
  periodEnd: string | null;
  limits: {
    maxCollections: number;
    maxPhotosPerCollection: number;
    label?: string;
  };
};

function getTierConfig(tier: AllTier): TierConfig {
  return tier === "free" ? FREE_TIER : TIERS[tier as PaidTier];
}

function featureValue(tier: AllTier, key: string): string {
  const config = getTierConfig(tier);
  switch (key) {
    case "collections":
      return `${config.maxCollections}`;
    case "photos":
      return `${config.maxPhotosPerCollection}`;
    default:
      return "✓";
  }
}

// ── Free card — web ────────────────────────────────────────
function FreeCard({
  isCurrentTier,
  width,
}: {
  isCurrentTier: boolean;
  width: number;
}) {
  const config = FREE_TIER;
  return (
    <View
      style={[
        freeCardStyles.card,
        { width },
        isCurrentTier && freeCardStyles.cardActive,
      ]}
    >
      {isCurrentTier && (
        <View style={freeCardStyles.badge}>
          <Text style={freeCardStyles.badgeText}>✓ Current Plan</Text>
        </View>
      )}
      <View style={[freeCardStyles.top, { backgroundColor: config.bg }]}>
        <Text style={freeCardStyles.emoji}>{config.emoji}</Text>
        <Text style={freeCardStyles.label}>{config.label}</Text>
        <Text style={freeCardStyles.tagline}>{config.tagline}</Text>
      </View>
      <View style={freeCardStyles.stats}>
        <View style={freeCardStyles.stat}>
          <Text style={freeCardStyles.statValue}>{config.maxCollections}</Text>
          <Text style={freeCardStyles.statLabel}>Albums</Text>
        </View>
        <View style={freeCardStyles.statDivider} />
        <View style={freeCardStyles.stat}>
          <Text style={freeCardStyles.statValue}>
            {config.maxPhotosPerCollection}
          </Text>
          <Text style={freeCardStyles.statLabel}>Photos each</Text>
        </View>
      </View>
      <View style={freeCardStyles.pricing}>
        <Text style={freeCardStyles.price}>Free</Text>
        <Text style={freeCardStyles.priceNote}>always</Text>
      </View>
      <View style={freeCardStyles.button}>
        <Text style={freeCardStyles.buttonText}>
          {isCurrentTier ? "✓ Your current plan" : "Always free"}
        </Text>
      </View>
    </View>
  );
}

// ── Free card — mobile ─────────────────────────────────────
function FreeCardMobile({ isCurrentTier }: { isCurrentTier: boolean }) {
  const config = FREE_TIER;
  return (
    <>
      <View style={[styles.mobileCardHeader, { backgroundColor: config.bg }]}>
        {isCurrentTier && (
          <View
            style={[styles.mobileCardBadge, { backgroundColor: config.accent }]}
          >
            <Text style={styles.mobileCardBadgeText}>✓ Current Plan</Text>
          </View>
        )}
        <Text style={styles.mobileCardEmoji}>{config.emoji}</Text>
        <Text style={styles.mobileCardLabel}>Free Album</Text>
        <Text style={styles.mobileCardTagline}>{config.tagline}</Text>
      </View>
      <View style={styles.mobileCardStats}>
        <View style={styles.mobileCardStat}>
          <Text style={[styles.mobileStatValue, { color: config.accent }]}>
            {config.maxCollections}
          </Text>
          <Text style={styles.mobileStatLabel}>Collections</Text>
        </View>
        <View style={styles.mobileCardStatDivider} />
        <View style={styles.mobileCardStat}>
          <Text style={[styles.mobileStatValue, { color: config.accent }]}>
            {config.maxPhotosPerCollection}
          </Text>
          <Text style={styles.mobileStatLabel}>Photos each</Text>
        </View>
      </View>
      <View style={styles.mobilePriceRow}>
        <Text style={[styles.mobilePriceAmount, { color: config.accent }]}>
          Free
        </Text>
        <Text style={styles.mobilePriceLabel}>always</Text>
      </View>
      <View style={styles.mobileFeatures}>
        {[
          "3 collections",
          "10 photos per collection",
          "Share with family & friends",
          "Secure cloud storage",
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
      <View
        style={[
          styles.mobileCardButton,
          {
            backgroundColor: "transparent",
            borderWidth: 1,
            borderColor: "#ddd",
            margin: 20,
          },
        ]}
      >
        <Text style={[styles.mobileCardButtonText, { color: "#888" }]}>
          {isCurrentTier ? "✓ Your current plan" : "Always free"}
        </Text>
      </View>
    </>
  );
}

// ── Comparison table ───────────────────────────────────────
function ComparisonTable({
  activeTier,
  isActiveFree,
  tableWidth,
}: {
  activeTier: PaidTier | null;
  isActiveFree: boolean;
  tableWidth: number;
}) {
  return (
    <View style={[tableStyles.table, { width: tableWidth }]}>
      <Text style={tableStyles.title}>Compare all plans</Text>
      <View style={tableStyles.row}>
        <View style={tableStyles.featureCol} />
        {ALL_TIERS.map((tier) => {
          const config = getTierConfig(tier);
          const isActive = tier === "free" ? isActiveFree : activeTier === tier;
          return (
            <View key={tier} style={tableStyles.valueCol}>
              <Text style={tableStyles.headerEmoji}>{config.emoji}</Text>
              <Text
                style={[
                  tableStyles.headerLabel,
                  { color: isActive ? config.accent : "#999" },
                  isActive && { fontWeight: "800" },
                ]}
              >
                {config.label}
              </Text>
            </View>
          );
        })}
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
          {ALL_TIERS.map((tier) => {
            const config = getTierConfig(tier);
            const isActive =
              tier === "free" ? isActiveFree : activeTier === tier;
            return (
              <View key={tier} style={tableStyles.valueCol}>
                <Text
                  style={[
                    tableStyles.value,
                    isActive && { color: config.accent, fontWeight: "700" },
                  ]}
                >
                  {featureValue(tier, feature.key)}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
      <View style={tableStyles.divider} />
      <View style={tableStyles.row}>
        <View style={tableStyles.featureCol}>
          <Ionicons name="pricetag-outline" size={13} color="#999" />
          <Text style={tableStyles.featureLabel}>Price (KES)</Text>
        </View>
        {ALL_TIERS.map((tier) => {
          const config = getTierConfig(tier);
          const isActive = tier === "free" ? isActiveFree : activeTier === tier;
          return (
            <View key={tier} style={tableStyles.valueCol}>
              {tier === "free" ? (
                <Text
                  style={[
                    tableStyles.price,
                    { color: isActive ? config.accent : "#bbb" },
                  ]}
                >
                  Free
                </Text>
              ) : (
                <>
                  <Text
                    style={[
                      tableStyles.price,
                      { color: isActive ? config.accent : "#444" },
                    ]}
                  >
                    {config.price.toLocaleString()}
                  </Text>
                  <Text style={tableStyles.priceSub}>per month</Text>
                </>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ── Main component ─────────────────────────────────────────
export default function SubscriptionPage() {
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const [status, setStatus] = useState<SubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<Tier | null>(null);
  const [selectedTier, setSelectedTier] = useState<AllTier>("medium");
  // Track session for guest purchase interception
  const [session, setSession] = useState<any>(null);

  const toggleAnim = useRef(new Animated.Value(1)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const cardFade = useRef(new Animated.Value(1)).current;
  const selectedTierRef = useRef<AllTier>("medium");

  const cardWidth = isDesktop
    ? Math.min(220, (Math.min(SCREEN_WIDTH, 960) - 100) / 4)
    : SCREEN_WIDTH - 48;

  // Track auth session
  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data: { session: s } }) => setSession(s));
    const {
      data: { subscription: authSub },
    } = supabase.auth.onAuthStateChange((_, s) => setSession(s));
    return () => authSub.unsubscribe();
  }, []);

  // Pulse animation for featured card
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

  // Load subscription status + set smart initial card
  useEffect(() => {
    supabase.functions
      .invoke("check-subscription")
      .then(({ data }) => {
        const tier: Tier = data?.tier ?? "free";
        const isActive: boolean = data?.isActive ?? false;
        const isLapsed: boolean = data?.isLapsed ?? false;

        setStatus({
          tier,
          isActive,
          isLapsed,
          periodEnd: data?.periodEnd ?? null,
          limits: data?.limits ?? {
            maxCollections: 3,
            maxPhotosPerCollection: 10,
          },
        });

        // Smart initial card: lapsed users land on their old tier to renew easily
        const initialTier: AllTier =
          (isActive || isLapsed) && ["small", "medium", "big"].includes(tier)
            ? tier
            : "medium";

        const initialIdx = ALL_TIERS.indexOf(initialTier);
        setSelectedTier(initialTier);
        selectedTierRef.current = initialTier;
        toggleAnim.setValue(initialIdx);
      })
      .finally(() => setLoading(false));
  }, []);

  // Resume pending purchase after login redirect
  useEffect(() => {
    if (!IS_WEB || typeof window === "undefined") return;
    const pendingTier = sessionStorage.getItem(
      "pendingTier",
    ) as PaidTier | null;
    if (!pendingTier) return;
    sessionStorage.removeItem("pendingTier");
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (s && pendingTier) {
        setTimeout(() => handlePurchase(pendingTier), 900);
      }
    });
  }, []);

  function switchTier(tier: AllTier) {
    selectedTierRef.current = tier;
    Animated.timing(cardFade, {
      toValue: 0,
      duration: 100,
      useNativeDriver: true,
    }).start(() => {
      setSelectedTier(tier);
      const idx = ALL_TIERS.indexOf(tier);
      Animated.timing(toggleAnim, {
        toValue: idx,
        duration: 200,
        useNativeDriver: false,
      }).start();
      Animated.timing(cardFade, {
        toValue: 1,
        duration: 160,
        useNativeDriver: true,
      }).start();
    });
  }

  async function handlePurchase(tier: PaidTier) {
    // ── Guest intercept ──
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();
    if (!currentSession) {
      if (IS_WEB && typeof window !== "undefined") {
        sessionStorage.setItem("pendingTier", tier);
      }
      router.push("/login?redirect=subscription");
      return;
    }

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

      if (IS_WEB) {
        const popup = window.open(
          "",
          "pesapal",
          "width=620,height=720,left=200,top=80",
        );
        if (!popup) {
          const { data, error } = await supabase.functions.invoke(
            "create-subscription",
            {
              body: { tier, callbackUrl },
            },
          );
          if (error) {
            console.error("create-subscription error:", error.message);
            throw new Error("Payment could not be started. Please try again.");
          }
          window.location.href = data.redirectUrl;
          return;
        }
        popup.document.write(
          `<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f9f9f9;flex-direction:column;gap:16px"><div style="font-size:48px">📸</div><div style="font-size:18px;font-weight:600;color:#111">Opening secure payment...</div><div style="font-size:13px;color:#999">Please wait a moment</div></body></html>`,
        );
        const { data, error } = await supabase.functions.invoke(
          "create-subscription",
          {
            body: { tier, callbackUrl },
          },
        );
        if (error) {
          console.error("create-subscription error:", error.message);
          popup.close();
          throw new Error("Payment could not be started. Please try again.");
        }
        const { redirectUrl, merchantReference } = data;
        popup.location.href = redirectUrl;
        const poll = setInterval(async () => {
          if (popup?.closed) {
            clearInterval(poll);
            try {
              const { data: sync } = await supabase.functions.invoke(
                "sync-subscription",
                {
                  body: { merchantReference, tier },
                },
              );
              if (sync?.status === "active") {
                try {
                  popup.close();
                } catch {}
                window.location.reload();
              } else {
                setPurchasing(null);
              }
            } catch (syncErr: any) {
              console.error("sync-subscription error:", syncErr.message);
              setPurchasing(null);
            }
          }
        }, 1000);
      }
    } catch (err: any) {
      console.error("handlePurchase error:", err.message);
      const userMessage = "Something went wrong. Please try again.";
      IS_WEB ? window.alert(userMessage) : Alert.alert("Error", userMessage);
      setPurchasing(null);
    }
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-KE", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

  async function handleCancel() {
    const message = `Are you sure you want to cancel? You will keep access to your ${status?.tier ? TIERS[status.tier as PaidTier]?.label : ""} plan until ${status?.periodEnd ? formatDate(status.periodEnd) : "the end of your billing period"}.`;

    const confirmed = IS_WEB
      ? window.confirm(message)
      : await new Promise<boolean>((resolve) => {
          Alert.alert("Cancel subscription", message, [
            {
              text: "Keep subscription",
              style: "cancel",
              onPress: () => resolve(false),
            },
            {
              text: "Cancel",
              style: "destructive",
              onPress: () => resolve(true),
            },
          ]);
        });

    if (!confirmed) return;

    try {
      const { data, error } = await supabase.functions.invoke(
        "cancel-subscription",
      );
      if (error) throw new Error(error.message);

      // Refresh status
      const { data: updated } =
        await supabase.functions.invoke("check-subscription");
      setStatus({
        tier: updated?.tier ?? "free",
        isActive: updated?.isActive ?? false,
        isLapsed: updated?.isLapsed ?? false,
        periodEnd: updated?.periodEnd ?? null,
        limits: updated?.limits ?? {
          maxCollections: 3,
          maxPhotosPerCollection: 10,
        },
      });

      const until = data?.accessUntil ? formatDate(data.accessUntil) : "";
      const msg = `Subscription cancelled. You have full access until ${until}.`;
      IS_WEB ? window.alert(msg) : Alert.alert("Cancelled", msg);
    } catch (err: any) {
      console.error("handleCancel error:", err.message);
      const userMessage = "Something went wrong. Please try again.";
      IS_WEB ? window.alert(userMessage) : Alert.alert("Error", userMessage);
    }
  }
  const activeTier = status?.isActive ? (status.tier as PaidTier) : null;
  const isActiveFree = !status?.isActive && !status?.isLapsed;

  const pillLeft = toggleAnim.interpolate({
    inputRange: [0, 1, 2, 3],
    outputRange: ["0%", "25%", "50%", "75%"],
  });

  function buyLabel(tier: PaidTier, isActive: boolean): string {
    if (isActive) return "✓ Active";
    if (status?.isLapsed && status.tier === tier) return "Renew plan";
    if (!session) return `Sign up to get ${TIERS[tier].label}`;
    return `Subscribe — KES ${TIERS[tier].price.toLocaleString()}/mo`;
  }

  function mobileBuyLabel(tier: PaidTier, isActive: boolean): string {
    if (isActive) return "✓ Active plan";
    if (status?.isLapsed && status.tier === tier)
      return `Renew ${TIERS[tier].label} — KES ${TIERS[tier].price.toLocaleString()}/mo`;
    if (!session)
      return `Sign up — KES ${TIERS[tier].price.toLocaleString()}/mo`;
    return `Subscribe — KES ${TIERS[tier].price.toLocaleString()}/mo`;
  }

  function mobileBuySub(isActive: boolean): string {
    if (isActive) return "";
    if (!session) return "Free to create an account";
    return "Billed monthly · Cancel anytime";
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/");
          }}
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
        <View style={styles.hero}>
          <Text style={styles.heroTitle}>Your life's best moments</Text>
          <Text style={styles.heroSub}>
            Billed monthly · Cancel anytime · Secure via Pesapal
          </Text>
        </View>

        {/* Guest nudge */}
        {!session && !loading && (
          <View style={styles.guestBanner}>
            <Text style={styles.guestBannerText}>
              👋 Create a free account to get started — or buy a plan right
              away.
            </Text>
          </View>
        )}

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
              {TIERS[activeTier].emoji} {TIERS[activeTier].label} · renews{" "}
              {status.periodEnd ? formatDate(status.periodEnd) : ""}
            </Text>
          </View>
        )}

        {/* Lapsed banner — was subscribed, period expired */}
        {status?.isLapsed && (
          <View style={[styles.lapsedBanner]}>
            <Ionicons name="warning-outline" size={16} color="#f59e0b" />
            <Text style={styles.lapsedBannerText}>
              Your {TIERS[status.tier as PaidTier]?.label ?? ""} plan expired
              {status.periodEnd ? ` on ${formatDate(status.periodEnd)}` : ""}.
              Renew below to restore access.
            </Text>
          </View>
        )}

        {session && isActiveFree && (
          <View style={[styles.activePill, { backgroundColor: "#888" }]}>
            <Ionicons name="checkmark-circle" size={14} color="#fff" />
            <Text style={styles.activePillText}>📓 Free Plan is active</Text>
          </View>
        )}

        {/* Cancel button — shown for active (non-cancelled) subscribers */}
        {status?.isActive && activeTier && (
          <TouchableOpacity style={styles.cancelLink} onPress={handleCancel}>
            <Text style={styles.cancelLinkText}>Cancel subscription</Text>
          </TouchableOpacity>
        )}

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color="#111" />
          </View>
        ) : isDesktop ? (
          /* ══ DESKTOP ══ */
          <>
            <View style={styles.webCardRow}>
              <FreeCard
                isCurrentTier={isActiveFree && !!session}
                width={cardWidth}
              />
              {PAID_TIERS.map((tier) => {
                const config = TIERS[tier];
                const isActive = activeTier === tier;
                const isFeatured = config.featured;
                const isPurchasing = purchasing === tier;
                const scaleTransform = isFeatured
                  ? [{ scale: pulseAnim }]
                  : isActive
                    ? [{ scale: 1.04 }]
                    : [{ scale: 1 }];
                const cardStyle = [
                  styles.webCard,
                  { width: cardWidth },
                  isFeatured && styles.webCardFeatured,
                  isActive && {
                    borderColor: config.accent,
                    borderWidth: 2,
                    ...Platform.select({
                      web: {
                        boxShadow: `0 8px 32px ${config.accent}33`,
                      } as any,
                      ios: {
                        shadowColor: config.accent,
                        shadowOffset: { width: 0, height: 8 },
                        shadowOpacity: 0.25,
                        shadowRadius: 16,
                      },
                      android: { elevation: 10 },
                    }),
                  },
                ];
                return (
                  <Animated.View
                    key={tier}
                    style={[cardStyle, { transform: scaleTransform }] as any}
                  >
                    {isFeatured && !isActive && (
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
                      <Text style={styles.webCardOnce}>/mo</Text>
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
                          {buyLabel(tier, isActive)}
                        </Text>
                      )}
                    </TouchableOpacity>
                  </Animated.View>
                );
              })}
            </View>
            <ComparisonTable
              activeTier={activeTier}
              isActiveFree={isActiveFree && !!session}
              tableWidth={Math.min(960, SCREEN_WIDTH - 48)}
            />
          </>
        ) : (
          /* ══ MOBILE ══ */
          <>
            <View style={styles.toggleWrapper}>
              <View style={styles.toggleTrack}>
                <Animated.View
                  style={[styles.togglePill, { left: pillLeft, width: "25%" }]}
                  pointerEvents="none"
                />
                {ALL_TIERS.map((tier) => {
                  const config = getTierConfig(tier);
                  const isSelected = selectedTier === tier;
                  const isTierActive =
                    tier === "free"
                      ? isActiveFree && !!session
                      : activeTier === tier;
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
                      {isTierActive && (
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

            <Animated.View
              style={[
                styles.mobileCard,
                { opacity: cardFade, width: cardWidth },
              ]}
            >
              {selectedTier === "free" ? (
                <FreeCardMobile isCurrentTier={isActiveFree && !!session} />
              ) : (
                (() => {
                  const displayTier = (
                    selectedTierRef.current !== "free"
                      ? selectedTierRef.current
                      : selectedTier
                  ) as PaidTier;
                  const config = TIERS[displayTier];
                  const isActive = activeTier === displayTier;
                  const isPurchasing = purchasing === displayTier;
                  return (
                    <>
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
                        <Text style={styles.mobileCardEmoji}>
                          {config.emoji}
                        </Text>
                        <Text style={styles.mobileCardLabel}>
                          {config.label} Album
                        </Text>
                        <Text style={styles.mobileCardTagline}>
                          {config.tagline}
                        </Text>
                      </View>
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
                          <Text style={styles.mobileStatLabel}>
                            Collections
                          </Text>
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
                          <Text style={styles.mobileStatLabel}>
                            Photos each
                          </Text>
                        </View>
                      </View>
                      {/* Price row — separate from stats to prevent cramping */}
                      <View style={styles.mobilePriceRow}>
                        <Text
                          style={[
                            styles.mobilePriceAmount,
                            { color: config.accent },
                          ]}
                        >
                          KES {config.price.toLocaleString()}
                        </Text>
                        <Text style={styles.mobilePriceLabel}>/month</Text>
                      </View>
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
                        onPress={() => handlePurchase(displayTier)}
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
                              {mobileBuyLabel(displayTier, isActive)}
                            </Text>
                            {!isActive && mobileBuySub(isActive) ? (
                              <Text style={styles.mobileCardButtonSub}>
                                {mobileBuySub(isActive)}
                              </Text>
                            ) : null}
                          </>
                        )}
                      </TouchableOpacity>
                    </>
                  );
                })()
              )}
            </Animated.View>

            <ComparisonTable
              activeTier={activeTier}
              isActiveFree={isActiveFree && !!session}
              tableWidth={cardWidth}
            />
          </>
        )}

        <Text style={styles.footer}>
          Payments processed securely by Pesapal.{"\n"}
          Supports M-Pesa, Visa and Mastercard.
        </Text>
      </ScrollView>
    </View>
  );
}

const freeCardStyles = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderRadius: 20,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#e8e8e8",
    ...Platform.select({
      web: { boxShadow: "0 4px 20px rgba(0,0,0,0.05)" } as any,
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.06,
        shadowRadius: 10,
      },
      android: { elevation: 3 },
    }),
  },
  cardActive: { borderColor: "#888", borderWidth: 2 },
  badge: { backgroundColor: "#888", paddingVertical: 5, alignItems: "center" },
  badgeText: { fontSize: 11, fontWeight: "700", color: "#fff" },
  top: { padding: 20, alignItems: "center", gap: 4 },
  emoji: { fontSize: 34, marginBottom: 4 },
  label: { fontSize: 17, fontWeight: "800", color: "#111" },
  tagline: {
    fontSize: 12,
    color: "#666",
    textAlign: "center",
    lineHeight: 17,
    marginTop: 4,
  },
  stats: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#f0f0f0",
  },
  stat: { flex: 1, alignItems: "center", paddingVertical: 14 },
  statValue: { fontSize: 26, fontWeight: "900", color: "#bbb" },
  statLabel: { fontSize: 11, color: "#bbb", marginTop: 2 },
  statDivider: { width: 1, backgroundColor: "#f0f0f0" },
  pricing: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    paddingTop: 16,
    paddingBottom: 8,
    gap: 6,
  },
  price: { fontSize: 26, fontWeight: "900", color: "#bbb" },
  priceNote: { fontSize: 12, color: "#ddd", marginBottom: 4 },
  button: {
    margin: 16,
    marginTop: 8,
    borderRadius: 12,
    padding: 13,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#eee",
    backgroundColor: "#fafafa",
  },
  buttonText: { color: "#bbb", fontSize: 13, fontWeight: "600" },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f7f7f9" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: IS_WEB ? 20 : 56,
    paddingBottom: 16,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: "#111" },
  page: { paddingBottom: 60, alignItems: "center" },
  centered: { paddingTop: 60 },
  hero: {
    alignItems: "center",
    paddingTop: 28,
    paddingBottom: 16,
    paddingHorizontal: 24,
  },
  heroTitle: {
    fontSize: IS_WEB ? 28 : 22,
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

  // Guest banner
  guestBanner: {
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#bfdbfe",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginHorizontal: 16,
    marginBottom: 12,
  },
  guestBannerText: {
    fontSize: 13,
    color: "#1d4ed8",
    lineHeight: 20,
    textAlign: "center",
  },

  activePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    marginBottom: 8,
  },
  activePillText: { fontSize: 13, fontWeight: "600", color: "#fff" },

  lapsedBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "#fffbeb",
    borderWidth: 1,
    borderColor: "#fde68a",
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 12,
  },
  lapsedBannerText: { flex: 1, fontSize: 13, color: "#92400e", lineHeight: 20 },

  cancelLink: { paddingVertical: 6, marginBottom: 8 },
  cancelLinkText: {
    fontSize: 12,
    color: "#bbb",
    textDecorationLine: "underline",
  },

  // Web cards
  webCardRow: {
    flexDirection: "row",
    gap: 14,
    paddingHorizontal: 20,
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

  // Mobile toggle
  toggleWrapper: { width: SCREEN_WIDTH - 32, marginBottom: 16, marginTop: 4 },
  toggleTrack: {
    flexDirection: "row",
    backgroundColor: "#efefef",
    borderRadius: 14,
    padding: 4,
    position: "relative",
    height: 56,
  },
  togglePill: {
    position: "absolute",
    top: 4,
    height: 48,
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
  toggleEmoji: { fontSize: 14 },
  toggleLabel: { fontSize: 11, color: "#888", fontWeight: "500" },
  toggleDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    position: "absolute",
    bottom: 4,
  },

  // Mobile card
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
  mobileStatValue: { fontSize: 22, fontWeight: "900" },
  mobileStatLabel: { fontSize: 11, color: "#888", marginTop: 3 },
  mobileCardStatDivider: { width: 1, backgroundColor: "#f0f0f0" },
  // Price displayed separately below stats — prevents cramping on small screens
  mobilePriceRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  mobilePriceAmount: {
    fontSize: 26,
    fontWeight: "900",
  },
  mobilePriceLabel: {
    fontSize: 14,
    color: "#888",
    fontWeight: "500",
  },
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
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  rowAlt: { backgroundColor: "#fafafa" },
  featureCol: { flex: 2, flexDirection: "row", alignItems: "center", gap: 6 },
  featureLabel: { fontSize: 12, color: "#555" },
  valueCol: { flex: 1, alignItems: "center", gap: 1 },
  headerEmoji: { fontSize: 16 },
  headerLabel: { fontSize: 11, fontWeight: "700" },
  value: { fontSize: 12, color: "#444", fontWeight: "500" },
  price: { fontSize: 13, fontWeight: "800" },
  priceSub: { fontSize: 10, color: "#999" },
  divider: { height: 1, backgroundColor: "#eee", marginHorizontal: 12 },
});
