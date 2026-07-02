import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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

export default function DeleteAccountPage() {
  const router = useRouter();
  const [session, setSession] = useState<any>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setCheckingSession(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_, s) => {
      setSession(s);
    });
    return () => subscription.unsubscribe();
  }, []);

  async function handleDeleteAccount() {
    const warningMessage =
      "This will permanently delete your account, all your collections, photos, and any collections shared with you. This action cannot be undone.";

    const firstConfirm = IS_WEB
      ? window.confirm(`Delete account?\n\n${warningMessage}`)
      : await new Promise<boolean>((resolve) => {
          Alert.alert("Delete account", warningMessage, [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            {
              text: "Continue",
              style: "destructive",
              onPress: () => resolve(true),
            },
          ]);
        });

    if (!firstConfirm) return;

    const secondConfirm = IS_WEB
      ? window.confirm(
          "Are you absolutely sure? This is your final confirmation — your account and all data will be permanently deleted.",
        )
      : await new Promise<boolean>((resolve) => {
          Alert.alert(
            "Final confirmation",
            "Are you absolutely sure? Your account and all data will be permanently deleted.",
            [
              {
                text: "Cancel",
                style: "cancel",
                onPress: () => resolve(false),
              },
              {
                text: "Delete my account",
                style: "destructive",
                onPress: () => resolve(true),
              },
            ],
          );
        });

    if (!secondConfirm) return;

    setDeleting(true);
    try {
      const { error } = await supabase.functions.invoke("delete-account");
      if (error) {
        console.error("delete-account error:", error.message);
        throw new Error("Could not delete account. Please try again.");
      }

      await supabase.auth.signOut();

      const doneMessage =
        "Your account has been deleted. All your data has been permanently removed.";
      if (IS_WEB) {
        window.alert(doneMessage);
      } else {
        Alert.alert("Account deleted", doneMessage);
      }

      router.replace("/login");
    } catch (err: any) {
      console.error("Delete account error:", err.message);
      const msg = "Could not delete account. Please try again.";
      IS_WEB ? window.alert(msg) : Alert.alert("Error", msg);
    } finally {
      setDeleting(false);
    }
  }

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
        <Text style={styles.headerTitle}>Delete Account</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.page, IS_DESKTOP && styles.pageDesktop]}
      >
        <View style={[styles.card, IS_DESKTOP && styles.cardDesktop]}>
          <Text style={styles.icon}>🗑️</Text>
          <Text style={styles.title}>Delete your Mems account</Text>
          <Text style={styles.sub}>
            We're sorry to see you go. Before you continue, here's exactly what
            happens when you delete your account.
          </Text>

          {/* What gets deleted */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>What will be deleted</Text>
            {[
              "Your account and login credentials",
              "All your collections and photos",
              "Any collections you shared with others",
              "Any collections others shared with you",
              "Your subscription and billing history",
            ].map((item) => (
              <View key={item} style={styles.row}>
                <View style={styles.dot} />
                <Text style={styles.rowText}>{item}</Text>
              </View>
            ))}
          </View>

          {/* Important notice */}
          <View style={styles.noticeBox}>
            <Ionicons name="warning-outline" size={16} color="#b45309" />
            <Text style={styles.noticeText}>
              This action is permanent and cannot be undone. We recommend
              downloading any photos you want to keep before deleting your
              account.
            </Text>
          </View>

          {/* Action area */}
          {checkingSession ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#111" />
            </View>
          ) : session ? (
            <>
              <Text style={styles.signedInAs}>
                Signed in as{" "}
                <Text style={styles.signedInEmail}>{session.user?.email}</Text>
              </Text>
              <TouchableOpacity
                style={[styles.deleteButton, deleting && { opacity: 0.7 }]}
                onPress={handleDeleteAccount}
                disabled={deleting}
              >
                {deleting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.deleteButtonText}>
                    Permanently delete my account
                  </Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.signInPrompt}>
                You need to sign in to delete your account.
              </Text>
              <TouchableOpacity
                style={styles.signInButton}
                onPress={() => router.push("/login?redirect=delete-account")}
              >
                <Text style={styles.signInButtonText}>Sign in to continue</Text>
              </TouchableOpacity>
            </>
          )}

          <TouchableOpacity
            style={styles.cancelLink}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace("/");
            }}
          >
            <Text style={styles.cancelLinkText}>Cancel — take me back</Text>
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
    maxWidth: 480,
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
  cardDesktop: { padding: 36 },

  icon: { fontSize: 44, marginBottom: 12 },
  title: {
    fontSize: 22,
    fontWeight: "800",
    color: "#111",
    textAlign: "center",
    marginBottom: 8,
  },
  sub: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    lineHeight: 21,
    marginBottom: 24,
  },

  section: { width: "100%", marginBottom: 20 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#999",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginBottom: 10,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(220,40,40,0.6)",
    marginTop: 6,
  },
  rowText: { flex: 1, fontSize: 14, color: "#333", lineHeight: 20 },

  noticeBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "#fffbeb",
    borderWidth: 1,
    borderColor: "#fde68a",
    borderRadius: 12,
    padding: 14,
    marginBottom: 24,
    width: "100%",
  },
  noticeText: { flex: 1, fontSize: 12.5, color: "#92400e", lineHeight: 18 },

  loadingRow: { paddingVertical: 12 },

  signedInAs: {
    fontSize: 13,
    color: "#888",
    marginBottom: 14,
    textAlign: "center",
  },
  signedInEmail: { color: "#111", fontWeight: "600" },

  deleteButton: {
    backgroundColor: "rgba(220,40,40,0.9)",
    borderRadius: 12,
    paddingVertical: 15,
    paddingHorizontal: 24,
    width: "100%",
    alignItems: "center",
    marginBottom: 12,
  },
  deleteButtonText: { color: "#fff", fontSize: 15, fontWeight: "700" },

  signInPrompt: {
    fontSize: 13,
    color: "#888",
    marginBottom: 14,
    textAlign: "center",
  },
  signInButton: {
    backgroundColor: "#111",
    borderRadius: 12,
    paddingVertical: 15,
    paddingHorizontal: 24,
    width: "100%",
    alignItems: "center",
    marginBottom: 12,
  },
  signInButtonText: { color: "#fff", fontSize: 15, fontWeight: "700" },

  cancelLink: { paddingVertical: 10 },
  cancelLinkText: { fontSize: 13, color: "#999" },
});
