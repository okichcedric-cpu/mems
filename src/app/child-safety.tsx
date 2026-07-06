import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  Dimensions,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const SCREEN_WIDTH = Dimensions.get("window").width;
const IS_WEB = Platform.OS === "web";
const IS_DESKTOP = IS_WEB && SCREEN_WIDTH >= 768;

const SUPPORT_EMAIL = "contact@mems-app.com";
const CSAM_CONTACT_EMAIL = "contact@mems-app.com";
const LAST_UPDATED = "July 3, 2026";

type Section = {
  title: string;
  body: React.ReactNode;
};

export default function ChildSafetyStandardsPage() {
  const router = useRouter();

  const sections: Section[] = [
    {
      title: "Our commitment",
      body: (
        <Text style={styles.paragraph}>
          Mems is a private photo album app built for families and friends to
          keep and share their most precious memories. We have a zero-tolerance
          policy toward child sexual abuse and exploitation (CSAE) and child
          sexual abuse material (CSAM) in any form. This page sets out Mems'
          published standards against CSAE and explains how we detect, prevent, report
          and act on any violation of these standards.
        </Text>
      ),
    },
    {
      title: "What we prohibit",
      body: (
        <>
          <Text style={styles.paragraph}>
            Mems strictly prohibits any content or behaviour that sexually
            exploits, abuses, or endangers a child. This includes but is not
            limited to:
          </Text>
          {[
            "Uploading, storing, or sharing any visual depiction — including photos, videos, or computer-generated imagery — involving a minor engaging in sexually explicit conduct",
            "Grooming, soliciting, or attempting to sexually exploit a child",
            "Sextortion or coercion of a minor",
            "Trafficking or attempting to traffic a child for sexual purposes",
            "Any other behaviour that sexualises, endangers, or exploits a child",
          ].map((item) => (
            <View key={item} style={styles.bulletRow}>
              <View style={styles.bulletDot} />
              <Text style={styles.bulletText}>{item}</Text>
            </View>
          ))}
        </>
      ),
    },
    {
      title: "How to report a concern",
      body: (
        <>
          <Text style={styles.paragraph}>
            If you encounter content or behaviour on Mems that you believe
            violates this policy, you can report it directly from within the app
            or by contacting us:
          </Text>
          <View style={styles.bulletRow}>
            <View style={styles.bulletDot} />
            <Text style={styles.bulletText}>
              In-app: open the profile menu in the top right corner of the app
              and select "About Mems", then use the contact link provided to
              reach our support team
            </Text>
          </View>
          <View style={styles.bulletRow}>
            <View style={styles.bulletDot} />
            <Text style={styles.bulletText}>
              By email:{" "}
              <Text
                style={styles.link}
                onPress={() => Linking.openURL(`mailto:${CSAM_CONTACT_EMAIL}`)}
              >
                {CSAM_CONTACT_EMAIL}
              </Text>
            </Text>
          </View>
          <Text style={[styles.paragraph, { marginTop: 8 }]}>
            All reports are reviewed promptly. You do not need a Mems account to
            submit a report.
          </Text>
        </>
      ),
    },
    {
      title: "How we respond",
      body: (
        <>
          <Text style={styles.paragraph}>
            When we obtain actual knowledge of CSAM or CSAE activity on Mems, we
            take immediate action in accordance with these published standards
            and applicable law, including:
          </Text>
          {[
            "Removing the offending content from our servers without delay",
            "Suspending or permanently disabling the account(s) responsible",
            "Preserving relevant records as required for a lawful investigation",
            "Reporting confirmed CSAM to the National Center for Missing & Exploited Children (NCMEC) and/or other appropriate authorities as required by law",
            "Cooperating with law enforcement requests relating to child safety",
          ].map((item) => (
            <View key={item} style={styles.bulletRow}>
              <View style={styles.bulletDot} />
              <Text style={styles.bulletText}>{item}</Text>
            </View>
          ))}
        </>
      ),
    },
    {
      title: "Compliance with child safety laws",
      body: (
        <Text style={styles.paragraph}>
          Mems complies with all applicable child safety laws in the
          jurisdictions in which it operates, including obligations to report
          apparent CSAM to designated authorities such as NCMEC's CyberTipline
          where legally required. These standards are informed by and consistent
          with the Tech Coalition's guidelines for combating online child sexual
          exploitation and abuse.
        </Text>
      ),
    },
    {
      title: "Child safety point of contact",
      body: (
        <Text style={styles.paragraph}>
          For matters relating to Mems' child safety practices and compliance
          with this policy, our designated point of contact can be reached at{" "}
          <Text
            style={styles.link}
            onPress={() => Linking.openURL(`mailto:${CSAM_CONTACT_EMAIL}`)}
          >
            {CSAM_CONTACT_EMAIL}
          </Text>
          .
        </Text>
      ),
    },
  ];

  return (
    <View style={styles.container}>
      {/* Header */}
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
        <Text style={styles.headerTitle}>Child Safety Standards</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.page, IS_DESKTOP && styles.pageDesktop]}
      >
        <View style={[styles.card, IS_DESKTOP && styles.cardDesktop]}>
          <Text style={styles.icon}>🛡️</Text>
          <Text style={styles.title}>
            Mems' Standards Against Child Sexual{"\n"}Abuse and Exploitation
          </Text>
          <Text style={styles.sub}>Last updated {LAST_UPDATED}</Text>

          {sections.map((section) => (
            <View key={section.title} style={styles.section}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              {section.body}
            </View>
          ))}

          <View style={styles.footerNote}>
            <Ionicons
              name="information-circle-outline"
              size={16}
              color="#888"
            />
            <Text style={styles.footerNoteText}>
              This page is publicly accessible without signing in and may be
              referenced as Mems' externally published standards against CSAE,
              as required under Google Play's Child Safety Standards policy.
            </Text>
          </View>

          <TouchableOpacity
            style={styles.contactButton}
            onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
          >
            <Ionicons name="mail-outline" size={16} color="#fff" />
            <Text style={styles.contactButtonText}>Contact Mems Support</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

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

  page: { padding: 20, paddingBottom: 60, alignItems: "center" },
  pageDesktop: { paddingTop: 48 },

  card: {
    width: "100%",
    maxWidth: 640,
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 28,
    borderWidth: 1,
    borderColor: "#eee",
    alignItems: "center",
    ...Platform.select({
      web: { boxShadow: "0 4px 20px rgba(0,0,0,0.05)" } as any,
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.05,
        shadowRadius: 12,
      },
      android: { elevation: 2 },
    }),
  },
  cardDesktop: { padding: 40 },

  icon: { fontSize: 40, marginBottom: 10 },
  title: {
    fontSize: 22,
    fontWeight: "800",
    color: "#111",
    textAlign: "center",
    lineHeight: 29,
    marginBottom: 6,
  },
  sub: {
    fontSize: 12.5,
    color: "#999",
    textAlign: "center",
    marginBottom: 28,
  },

  section: { width: "100%", marginBottom: 22 },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111",
    marginBottom: 8,
  },
  paragraph: {
    fontSize: 13.5,
    color: "#444",
    lineHeight: 21,
  },
  bulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginTop: 8,
  },
  bulletDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#999",
    marginTop: 7,
  },
  bulletText: {
    flex: 1,
    fontSize: 13.5,
    color: "#444",
    lineHeight: 21,
  },
  link: {
    color: "#4A90E8",
    fontWeight: "600",
  },

  footerNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "#f5f7fa",
    borderRadius: 12,
    padding: 14,
    width: "100%",
    marginBottom: 20,
  },
  footerNoteText: {
    flex: 1,
    fontSize: 12,
    color: "#777",
    lineHeight: 18,
  },

  contactButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#111",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
  },
  contactButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
});
