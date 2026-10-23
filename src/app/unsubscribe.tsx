import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

// ── Unsubscribe from the "create your first collection" reminder email ──
// Public page (no login needed — it's opened from an email link). Landing
// here changes nothing by itself: the actual unsubscribe only happens when
// the button is pressed, which guards against email security scanners that
// open every link in a message. The signed `t` token in the URL is checked
// server-side by the unsubscribe-nudge edge function.

const FUNCTION_URL = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/unsubscribe-nudge`;

type Status = "idle" | "loading" | "done" | "error";

export default function UnsubscribePage() {
  const params = useLocalSearchParams<{ u?: string; t?: string }>();
  const u = Array.isArray(params.u) ? params.u[0] : params.u;
  const t = Array.isArray(params.t) ? params.t[0] : params.t;
  const [status, setStatus] = useState<Status>("idle");

  const linkIsUsable = !!u && !!t;

  async function handleUnsubscribe() {
    if (!linkIsUsable) return;
    setStatus("loading");
    try {
      const res = await fetch(FUNCTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ u, t }),
      });
      setStatus(res.ok ? "done" : "error");
    } catch {
      setStatus("error");
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.logo}>Mems</Text>

        {status === "done" ? (
          <>
            <Text style={styles.title}>You're unsubscribed</Text>
            <Text style={styles.body}>
              We won't send you any more reminder emails about creating your
              first collection.
            </Text>
          </>
        ) : !linkIsUsable ? (
          <>
            <Text style={styles.title}>This link isn't valid</Text>
            <Text style={styles.body}>
              The unsubscribe link looks incomplete. Please use the link from
              the email, or write to contact@mems-app.com and we'll sort it
              out.
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.title}>Unsubscribe from reminders?</Text>
            <Text style={styles.body}>
              You'll stop getting the reminder email about creating your first
              collection. You'll still get emails about things you do in Mems,
              like shares and subscription notices.
            </Text>

            {status === "error" && (
              <Text style={styles.error}>
                Something went wrong. Please try again, or write to
                contact@mems-app.com.
              </Text>
            )}

            <TouchableOpacity
              style={[styles.button, status === "loading" && styles.buttonDisabled]}
              onPress={handleUnsubscribe}
              disabled={status === "loading"}
              activeOpacity={0.85}
            >
              {status === "loading" ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Unsubscribe</Text>
              )}
            </TouchableOpacity>
          </>
        )}

        <TouchableOpacity
          onPress={() => Linking.openURL("https://www.mems-app.com")}
          style={styles.homeLink}
        >
          <Text style={styles.homeLinkText}>Go to Mems</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f7f7f9",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    maxWidth: 440,
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 32,
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
  logo: { fontSize: 28, fontWeight: "800", color: "#111", marginBottom: 20 },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: "#111",
    textAlign: "center",
    marginBottom: 12,
  },
  body: {
    fontSize: 15,
    color: "#555",
    lineHeight: 23,
    textAlign: "center",
    marginBottom: 24,
  },
  error: {
    fontSize: 14,
    color: "#c0392b",
    textAlign: "center",
    marginBottom: 16,
  },
  button: {
    backgroundColor: "#111",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 32,
    minWidth: 160,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  homeLink: { marginTop: 24 },
  homeLinkText: { fontSize: 13, color: "#999" },
});
