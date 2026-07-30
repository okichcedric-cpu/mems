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

export default function TermsOfService() {
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
            <Text style={styles.heroEmoji}>📋</Text>
            <Text style={styles.heroTitle}>Terms of Service</Text>
            <Text style={styles.heroSubtitle}>
              Simple, fair, and transparent — just like we are.
            </Text>
          </View>

          {/* Intro */}
          <View style={styles.introCard}>
            <Text style={styles.introText}>
              By using Mems, you're agreeing to these terms. We've written them
              in plain language because we believe the people who use our app
              deserve to understand what they're agreeing to.
            </Text>
          </View>

          {/* Sections */}
          {[
            {
              emoji: "👋",
              title: "1. Who We Are",
              body: "Mems is a digital photo album app that lets you create, store, and share photo collections with the people you love. We're a small team that cares deeply about preserving your memories.",
            },
            {
              emoji: "✅",
              title: "2. Accepting These Terms",
              body: "By creating an account or using Mems in any way, you agree to be bound by these terms. If you don't agree, please don't use the app; though we'd love to know why so we can do better.",
            },
            {
              emoji: "🗂️",
              title: "3. Free and Pro Accounts",
              body: "Free accounts are limited to 3 collections with a maximum of 10 photos per collection. Pro subscriptions unlock more collections and photos and are billed monthly. You can cancel at any time though your access continues until the end of your current billing period with no partial refunds.",
            },
            {
              emoji: "💳",
              title: "4. Payments",
              body: "Payments are processed securely by Pesapal and support M-Pesa, Visa, and Mastercard. Mems never stores your card or payment details. All transactions are subject to Pesapal's own terms and conditions.",
            },
            {
              emoji: "📸",
              title: "5. Your Content",
              body: "Every photo you upload belongs entirely to you. We don't claim ownership of your memories. By uploading content, you grant Mems a licence to store your photos solely to provide the service to you, nothing more.",
            },
            {
              emoji: "🤝",
              title: "6. Sharing Collections",
              body: "When you share a collection, the recipient can view and add photos to it. You can remove their access at any time. You're responsible for what you share and must ensure you have the right to share the content you do.",
            },
            {
              emoji: "🚫",
              title: "7. What You Cannot Do",
              body: "You agree not to use Mems to upload or share illegal, harmful, or copyright-infringing content. You may not attempt to reverse engineer the app, scrape data, or use Mems in ways that could harm other users. We reserve the right to suspend accounts that violate these terms.",
            },
            {
              emoji: "⚖️",
              title: "8. Limitation of Liability",
              body: 'Mems is provided on an "as is" basis. While we work hard to keep your memories safe, we cannot be held liable for any loss of data, loss of revenue, or indirect damages arising from your use of the app. Please back up anything truly irreplaceable.',
            },
            {
              emoji: "🔄",
              title: "9. Changes to These Terms",
              body: "We may update these terms as the app grows. When we do, we'll let you know by email or in-app notification. Continuing to use Mems after changes are posted means you accept the updated terms.",
            },
            {
              emoji: "📬",
              title: "10. Get in Touch",
              body: "Have a question about these terms? We're real people and we're happy to talk. Reach us at contact@mems-app.com.",
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

          {/* Footer CTA */}
          <View style={styles.footerCard}>
            <Text style={styles.footerText}>
              Questions or concerns? We're here.
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
    borderLeftColor: "#111",
  },
  introText: {
    fontSize: 15,
    color: "#555",
    lineHeight: 24,
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
    backgroundColor: "#111",
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    marginTop: 32,
    gap: 8,
  },
  footerText: {
    fontSize: 15,
    color: "rgba(255,255,255,0.7)",
    textAlign: "center",
  },
  footerEmail: {
    fontSize: 16,
    color: "#fff",
    fontWeight: "700",
  },
});
