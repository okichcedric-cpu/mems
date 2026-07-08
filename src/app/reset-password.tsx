import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { supabase } from "../utils/supabase";

const SCREEN_WIDTH = Dimensions.get("window").width;
const IS_WEB = Platform.OS === "web";
const IS_DESKTOP = IS_WEB && SCREEN_WIDTH >= 768;

// ── Why this screen exists ────────────────────────────────────
// Previously, resetPasswordForEmail() pointed its redirectTo at
// "/reset-password" (web) or "mems://reset-password" (native), but no
// screen existed at that route — clicking the emailed link landed on a
// 404/blank page (web) or nowhere at all (native), i.e. a dead link.
// This screen is that missing destination.
//
// On web, Supabase's client has detectSessionInUrl: true (see
// utils/supabase.ts), so it automatically exchanges the recovery code
// found in the URL for a real session as soon as this page's JS loads —
// we just need to notice when that happens. On native, the code is
// exchanged by the deep link listener in app/_layout.tsx (which then
// navigates here), so a session is typically already present by the
// time this screen mounts.
export default function ResetPasswordScreen() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [validLink, setValidLink] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const resolvedRef = useRef(false);

  useEffect(() => {
    function resolve(hasSession: boolean) {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      setValidLink(hasSession);
      setChecking(false);
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (
        event === "PASSWORD_RECOVERY" ||
        (event === "SIGNED_IN" && session)
      ) {
        resolve(true);
      }
    });

    // Covers the case where the code was already exchanged (e.g. by the
    // native deep link listener) before this screen finished mounting.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) resolve(true);
    });

    // If nothing establishes a session within a few seconds, the link is
    // treated as invalid/expired rather than leaving the user staring at
    // a spinner forever.
    const timeout = setTimeout(() => resolve(false), 5000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  async function handleSubmit() {
    if (password.length < 8) {
      const msg = "Password must be at least 8 characters.";
      IS_WEB ? window.alert(msg) : Alert.alert("Weak password", msg);
      return;
    }
    if (password !== confirmPassword) {
      const msg = "Passwords do not match.";
      IS_WEB ? window.alert(msg) : Alert.alert("Error", msg);
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setDone(true);
    } catch (error: any) {
      console.error("Reset password error:", error.message);
      const msg =
        "Could not reset your password. Please request a new link and try again.";
      IS_WEB ? window.alert(msg) : Alert.alert("Error", msg);
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#111" />
      </View>
    );
  }

  if (!validLink) {
    return (
      <View style={styles.container}>
        <View style={[styles.card, IS_DESKTOP && styles.cardDesktop]}>
          <Text style={styles.icon}>⚠️</Text>
          <Text style={styles.title}>Link expired</Text>
          <Text style={styles.sub}>
            This password reset link is invalid or has expired. Please
            request a new one from the sign in screen.
          </Text>
          <TouchableOpacity
            style={styles.submitButton}
            onPress={() => router.replace("/login")}
          >
            <Text style={styles.submitButtonText}>Back to sign in</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (done) {
    return (
      <View style={styles.container}>
        <View style={[styles.card, IS_DESKTOP && styles.cardDesktop]}>
          <Text style={styles.icon}>✅</Text>
          <Text style={styles.title}>Password updated</Text>
          <Text style={styles.sub}>
            Your password has been changed successfully.
          </Text>
          <TouchableOpacity
            style={styles.submitButton}
            onPress={async () => {
              await supabase.auth.signOut();
              router.replace("/login");
            }}
          >
            <Text style={styles.submitButtonText}>Continue to sign in</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.card, IS_DESKTOP && styles.cardDesktop]}>
        <Text style={styles.icon}>🔒</Text>
        <Text style={styles.title}>Set a new password</Text>
        <Text style={styles.sub}>
          Choose a new password for your account.
        </Text>

        <TextInput
          style={styles.input}
          placeholder="New password"
          placeholderTextColor="#999"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          placeholder="Confirm new password"
          placeholderTextColor="#999"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry
          autoCapitalize="none"
        />

        <TouchableOpacity
          style={[styles.submitButton, submitting && { opacity: 0.7 }]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitButtonText}>Update password</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f7f7f9",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
  },
  card: {
    width: "100%",
    maxWidth: 420,
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
  input: {
    width: "100%",
    borderWidth: 1,
    borderColor: "#e0e0e0",
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: "#111",
    marginBottom: 12,
    backgroundColor: "#fafafa",
  },
  submitButton: {
    backgroundColor: "#111",
    borderRadius: 12,
    padding: 15,
    alignItems: "center",
    width: "100%",
    marginTop: 4,
  },
  submitButtonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
