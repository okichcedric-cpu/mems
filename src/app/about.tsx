import { useRouter } from "expo-router";
import {
  Dimensions,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const SCREEN_WIDTH = Dimensions.get("window").width;
const CONTENT_WIDTH =
  Platform.OS === "web" ? Math.min(640, SCREEN_WIDTH * 0.9) : SCREEN_WIDTH;

export default function AboutPage() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.content, { width: CONTENT_WIDTH }]}>
          {/* Hero */}
          <View style={styles.hero}>
            <Image
              source={require("@/assets/images/icon.png")}
              style={styles.heroLogo}
              resizeMode="contain"
            />
            <Text style={styles.heroTitle}>Mems</Text>
            <Text style={styles.heroTagline}>
              Your Digital Album for Life's Best Moments
            </Text>
          </View>

          {/* Story section */}
          <View style={styles.section}>
            <Text style={styles.sectionEmoji}>📖</Text>
            <Text style={styles.sectionTitle}>Remember the Album?</Text>
            <Text style={styles.sectionBody}>
              There was a time when every family had one, an album tucked away
              on a shelf, next to some old hard cover books or under the coffee
              table. You'd flip through it slowly, each plastic sleeve holding
              photos that told a story. A birthday party, that out of town road
              trip, that lazy Sunday afternoon that felt ordinary then but
              golden now.
            </Text>
            <Text style={styles.sectionBody}>
              They were sacred and how families held on to memories. How
              grandparents showed grandchildren where they came from.
            </Text>
          </View>

          {/* Problem section */}
          <View style={styles.section}>
            <Text style={styles.sectionEmoji}>📱</Text>
            <Text style={styles.sectionTitle}>
              What Happened to Our Photos?
            </Text>
            <Text style={styles.sectionBody}>
              Today we take more photos than ever before, thousands of them, but
              somehow they feel less permanent. They're buried in a phone camera
              roll or lost in a group chat. We don't even remember what photos
              we have! Scattered across three different cloud services and old
              or lost phones.
            </Text>
            <Text style={styles.sectionBody}>
              The memories are there. But just all over the place.
            </Text>
          </View>

          {/* Solution section */}
          <View style={styles.section}>
            <Text style={styles.sectionEmoji}>✨</Text>
            <Text style={styles.sectionTitle}>Mems Brings the Album Back</Text>
            <Text style={styles.sectionBody}>
              Mems is a modern take on the photo album you grew up with; Simple,
              Beautiful, and built to last. Create a collection for any chapter
              of your life. A holiday. A wedding. The first year of a child's
              life. Your grandmother's 80th birthday.
            </Text>
            <Text style={styles.sectionBody}>
              Then share it with the people who were there. Not a link that will
              expire. Not a download they'll forget to open. A shared album that
              lives on their Mems too, always there when they want to remember.
            </Text>
          </View>

          {/* Generations section */}
          <View style={styles.section}>
            <Text style={styles.sectionEmoji}>🌍</Text>
            <Text style={styles.sectionTitle}>
              Photos That Last for Generations
            </Text>
            <Text style={styles.sectionBody}>
              The photos you take today are the history your children and
              grandchildren will look back to. Mems is built with that in mind.
              Your collections are stored securely in the cloud, accessible
              across devices, not just tied to a device that can break, a phone
              that can be stolen, or a hard drive that can get lost.
            </Text>
            <Text style={styles.sectionBody}>
              The album your grandmother kept for fifty years deserved to last
              forever. So do yours.
            </Text>
          </View>

          {/* Features section */}
          <View style={styles.featuresCard}>
            <Text style={styles.featuresTitle}>
              Photos you want to remember, nothing you don't
            </Text>
            {[
              {
                emoji: "🗂️",
                label: "Create collections",
                desc: "Organise your photos into beautiful albums",
              },
              {
                emoji: "📤",
                label: "Share with loved ones",
                desc: "Give family and friends access with a tap",
              },
              {
                emoji: "☁️",
                label: "Stored securely",
                desc: "Your photos safe in the cloud, always",
              },
              {
                emoji: "📲",
                label: "Works everywhere",
                desc: "iOS, Android and web — always in sync",
              },
              {
                emoji: "♾️",
                label: "Built to last",
                desc: "Your memories preserved for generations",
              },
            ].map((feature) => (
              <View key={feature.label} style={styles.featureRow}>
                <Text style={styles.featureEmoji}>{feature.emoji}</Text>
                <View style={styles.featureText}>
                  <Text style={styles.featureLabel}>{feature.label}</Text>
                  <Text style={styles.featureDesc}>{feature.desc}</Text>
                </View>
              </View>
            ))}
          </View>

          {/* CTA */}
          <View style={styles.ctaSection}>
            <Text style={styles.ctaText}>
              Your life's best moments deserve a home.
            </Text>
            <TouchableOpacity
              style={styles.ctaButton}
              onPress={() => router.back()}
            >
              <Text style={styles.ctaButtonText}>Start your album →</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },

  // ── Header ────────────────────────────────────────────────
  header: {
    paddingHorizontal: 20,
    paddingTop: Platform.OS === "web" ? 20 : 56,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  backButton: { alignSelf: "flex-start" },
  backText: { fontSize: 15, color: "#111", fontWeight: "500" },

  // ── Scroll ────────────────────────────────────────────────
  scrollContent: {
    alignItems: "center",
    paddingBottom: 60,
  },
  content: {
    paddingHorizontal: Platform.OS === "web" ? 0 : 24,
  },

  // ── Hero ─────────────────────────────────────────────────
  hero: {
    alignItems: "center",
    paddingVertical: 40,
    borderBottomWidth: 1,
    borderBottomColor: "#f5f5f5",
    marginBottom: 8,
  },
  heroLogo: {
    width: Math.min(100, SCREEN_WIDTH * 0.25),
    height: Math.min(100, SCREEN_WIDTH * 0.25),
    marginBottom: 12,
  },
  heroTitle: {
    fontSize: 36,
    fontWeight: "800",
    color: "#111",
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  heroTagline: {
    fontSize: 16,
    color: "#888",
    textAlign: "center",
    lineHeight: 24,
    fontStyle: "italic",
    maxWidth: 280,
  },

  // ── Sections ─────────────────────────────────────────────
  section: {
    paddingVertical: 32,
    borderBottomWidth: 1,
    borderBottomColor: "#f5f5f5",
  },
  sectionEmoji: {
    fontSize: 32,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#111",
    marginBottom: 16,
    lineHeight: 28,
  },
  sectionBody: {
    fontSize: 16,
    color: "#555",
    lineHeight: 26,
    marginBottom: 14,
  },

  // ── Features card ─────────────────────────────────────────
  featuresCard: {
    backgroundColor: "#f9f9f9",
    borderRadius: 16,
    padding: 24,
    marginVertical: 32,
    borderWidth: 1,
    borderColor: "#eee",
  },
  featuresTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111",
    marginBottom: 20,
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 16,
    gap: 14,
  },
  featureEmoji: { fontSize: 22, marginTop: 2 },
  featureText: { flex: 1 },
  featureLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: "#111",
    marginBottom: 2,
  },
  featureDesc: { fontSize: 13, color: "#777", lineHeight: 18 },

  // ── CTA ──────────────────────────────────────────────────
  ctaSection: {
    alignItems: "center",
    paddingVertical: 16,
    gap: 16,
  },
  ctaText: {
    fontSize: 18,
    fontWeight: "600",
    color: "#111",
    textAlign: "center",
    lineHeight: 26,
    fontStyle: "italic",
  },
  ctaButton: {
    backgroundColor: "#111",
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
  },
  ctaButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
});
