import { useRouter } from "expo-router";
import {
  Dimensions,
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

export default function PrivacyPolicy() {
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
            <Text style={styles.heroEmoji}>🔒</Text>
            <Text style={styles.heroTitle}>Privacy Policy</Text>
            <Text style={styles.heroSubtitle}>
              Your memories are yours. We're just looking after them.
            </Text>
          </View>

          {/* Intro */}
          <View style={styles.introCard}>
            <Text style={styles.introText}>
              Privacy isn't a legal formality for us, it's a promise. Mems was
              built on the belief that your photos and personal moments deserve
              to be protected. Here's exactly how we do that.
            </Text>
          </View>

          {/* Trust badges */}
          <View style={styles.badgeRow}>
            {[
              { emoji: "🔐", label: "Encrypted storage" },
              { emoji: "🚫", label: "Never sold" },
              { emoji: "👤", label: "You own your data" },
            ].map((badge) => (
              <View key={badge.label} style={styles.badge}>
                <Text style={styles.badgeEmoji}>{badge.emoji}</Text>
                <Text style={styles.badgeLabel}>{badge.label}</Text>
              </View>
            ))}
          </View>

          {/* Sections */}
          {[
            {
              emoji: "📖",
              title: "1. Who This Applies To",
              body: "This policy applies to everyone who uses Mems; on Web, Android, or iOS. By using the app, you agree to the practices explained here.",
            },
            {
              emoji: "📦",
              title: "2. What We Collect",
              body: "We collect the minimum needed to run the platform:\n\n• Your email address — for login and important notifications\n• Photos you choose to upload — stored securely in the cloud\n• Collection names and sharing relationships\n• Payment records (processed by Pesapal — we never see your card)\n• Usage data; collecting bugs that occur or any crashes\n\nThat's it. We don't track you across any other apps or websites.",
            },
            {
              emoji: "🎯",
              title: "3. How We Use It",
              body: "Every piece of data we collect has a specific purpose:\n\n• Email — to authenticate you and send important account messages\n• Photos — to display your collections to you and people you share with\n• Sharing data — to connect owners and recipients of shared collections\n• Payments — to manage your subscription\n\nWe DO NOT use your data for advertising.",
            },
            {
              emoji: "👨‍👩‍👧",
              title: "4. Sharing Collections",
              body: "When you share a collection, only the specific person you invite gains access to the photos in it. They cannot reshare it. You can revoke access at any time. If you delete a collection, it disappears from their view immediately.",
            },
            {
              emoji: "🕰️",
              title: "5. How Long We Keep Your Data",
              body: "We keep your data for as long as your account is active. If you delete your account, all your photos, collections, and personal data are permanently removed immediately. Payment records may be retained longer for legal and accounting purposes as required by law.",
            },
            {
              emoji: "✊",
              title: "6. Your Rights",
              body: "You are always in control:\n\n• Access — ask us what data we hold about you\n• Correct — fix anything that's inaccurate\n• Delete — remove your account and all your data\n\nTo exercise any of these rights, email us at contact@mems-app.com.",
            },
            {
              emoji: "🍪",
              title: "7. Cookies",
              body: "The Mems web app uses only the cookies required for authentication — nothing more. We don't use advertising cookies, third-party trackers, or any technology designed to follow you around the internet.",
            },
            {
              emoji: "👶",
              title: "8. Children's Privacy",
              body: "Mems is not designed for or directed at children under 13. We don't knowingly collect personal data from children. If you believe a child has created an account, please contact us immediately and we will remove it.",
            },
            {
              emoji: "🔄",
              title: "9. Policy Updates",
              body: "If we make significant changes to this policy, we'll notify you by email before the changes take effect.",
            },
          ].map((section) => (
            <View key={section.title} style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionEmoji}>{section.emoji}</Text>
                <Text style={styles.sectionTitle}>{section.title}</Text>
              </View>
              <Text style={styles.sectionBody}>{section.body}</Text>
            </View>
          ))}

          {/* Footer card */}
          <View style={styles.footerCard}>
            <Text style={styles.footerEmoji}>💬</Text>
            <Text style={styles.footerTitle}>Privacy questions?</Text>
            <Text style={styles.footerText}>
              We take these seriously. If you have any questions, concerns, or
              requests relating to your privacy, please reach out directly.
            </Text>
            <Text style={styles.footerEmail}>contact@mems-app.com</Text>
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
  heroEmoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  heroTitle: {
    fontSize: 32,
    fontWeight: "800",
    color: "#111",
    letterSpacing: -0.5,
    marginBottom: 8,
    textAlign: "center",
  },
  heroSubtitle: {
    fontSize: 15,
    color: "#888",
    textAlign: "center",
    fontStyle: "italic",
    lineHeight: 22,
    marginBottom: 12,
    maxWidth: 280,
  },
  heroDate: {
    fontSize: 12,
    color: "#bbb",
  },

  // ── Intro card ────────────────────────────────────────────
  introCard: {
    backgroundColor: "#f9f9f9",
    borderRadius: 14,
    padding: 20,
    marginVertical: 24,
    borderLeftWidth: 3,
    borderLeftColor: "#4A90E8",
  },
  introText: {
    fontSize: 15,
    color: "#555",
    lineHeight: 24,
  },

  // ── Trust badges ─────────────────────────────────────────
  badgeRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 24,
  },
  badge: {
    flex: 1,
    backgroundColor: "#f5f9ff",
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#e0eeff",
  },
  badgeEmoji: { fontSize: 22 },
  badgeLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#4A90E8",
    textAlign: "center",
    lineHeight: 14,
  },

  // ── Sections ─────────────────────────────────────────────
  section: {
    paddingVertical: 24,
    borderBottomWidth: 1,
    borderBottomColor: "#f5f5f5",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  sectionEmoji: { fontSize: 22 },
  sectionTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111",
    flex: 1,
  },
  sectionBody: {
    fontSize: 15,
    color: "#555",
    lineHeight: 26,
  },

  // ── Footer card ───────────────────────────────────────────
  footerCard: {
    backgroundColor: "#f5f9ff",
    borderRadius: 16,
    padding: 28,
    alignItems: "center",
    marginTop: 32,
    gap: 8,
    borderWidth: 1,
    borderColor: "#e0eeff",
  },
  footerEmoji: { fontSize: 32, marginBottom: 4 },
  footerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111",
    textAlign: "center",
  },
  footerText: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    lineHeight: 22,
    maxWidth: 320,
  },
  footerEmail: {
    fontSize: 16,
    color: "#4A90E8",
    fontWeight: "700",
    marginTop: 4,
  },
});
