import { AntDesign } from "@expo/vector-icons";
import { makeRedirectUri } from "expo-auth-session";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { supabase } from "../utils/supabase";

WebBrowser.maybeCompleteAuthSession();

const redirectTo = makeRedirectUri();
const SCREEN_WIDTH = Dimensions.get("window").width;

const FORM_WIDTH =
  Platform.OS === "web" ? Math.min(420, SCREEN_WIDTH * 0.9) : SCREEN_WIDTH - 48;

type Mode = "login" | "signup";

async function signInWithGoogle() {
  if (Platform.OS === "web") {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin, // ← just the domain, no path
        queryParams: {
          access_type: "offline",
          prompt: "consent",
        },
      },
    });
    if (error) Alert.alert("Error", error.message);
  } else {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) Alert.alert("Error", error.message);
    if (data?.url) await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  }
}

export default function LoginScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);

  async function handleEmailAuth() {
    if (!email.trim()) {
      Alert.alert("Error", "Please enter your email address.");
      return;
    }
    if (!password) {
      Alert.alert("Error", "Please enter your password.");
      return;
    }
    if (mode === "signup") {
      if (password.length < 8) {
        Alert.alert("Weak password", "Password must be at least 8 characters.");
        return;
      }
      if (password !== confirmPassword) {
        Alert.alert("Error", "Passwords do not match.");
        return;
      }
    }

    setLoading(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
        });
        if (error) throw error;
        setShowConfirmation(true);
      }
    } catch (error: any) {
      if (Platform.OS === "web") {
        window.alert(error.message);
      } else {
        Alert.alert("Error", error.message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    if (!email.trim()) {
      Alert.alert("Enter your email", "Please enter your email address first.");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        {
          redirectTo:
            Platform.OS === "web"
              ? `${window.location.origin}/reset-password`
              : redirectTo,
        },
      );
      if (error) throw error;
      if (Platform.OS === "web") {
        window.alert("Password reset email sent. Check your inbox.");
      } else {
        Alert.alert(
          "Email sent",
          "Check your inbox for a password reset link.",
        );
      }
    } catch (error: any) {
      Alert.alert("Error", error.message);
    } finally {
      setLoading(false);
    }
  }

  // Email confirmation screen
  if (showConfirmation) {
    return (
      <View style={styles.container}>
        <View style={styles.confirmationCard}>
          <Text style={styles.confirmationIcon}>📧</Text>
          <Text style={styles.confirmationTitle}>Check your email</Text>
          <Text style={styles.confirmationText}>
            We sent a confirmation link to{"\n"}
            <Text style={styles.confirmationEmail}>{email}</Text>
            {"\n\n"}
            Click the link to activate your account then come back to sign in.
          </Text>
          <TouchableOpacity
            style={[styles.submitButton, { width: FORM_WIDTH }]}
            onPress={() => {
              setShowConfirmation(false);
              setMode("login");
              setPassword("");
              setConfirmPassword("");
            }}
          >
            <Text style={styles.submitButtonText}>Back to Sign In</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          {/* Logo */}
          <View style={styles.logoContainer}>
            <Image
              source={require("@/assets/images/icon.png")}
              style={styles.logo}
              resizeMode="contain"
            />
          </View>

          {/* Tagline — shown subtly below the logo */}
          <Text style={styles.tagline}>
            Your life's best moments,{"\n"}all in one place.
          </Text>

          {/* About link — subtle, doesn't disrupt flow */}
          <TouchableOpacity
            style={styles.aboutLink}
            onPress={() => router.push("/about")}
          >
            <Text style={styles.aboutLinkText}>What is Mems? ›</Text>
          </TouchableOpacity>

          {/* Divider between hero and form */}
          <View style={[styles.sectionDivider, { width: FORM_WIDTH }]} />

          {/* Mode toggle */}
          <View style={[styles.modeToggle, { width: FORM_WIDTH }]}>
            <TouchableOpacity
              style={[
                styles.modeButton,
                mode === "login" && styles.modeButtonActive,
              ]}
              onPress={() => {
                setMode("login");
                setConfirmPassword("");
              }}
            >
              <Text
                style={[
                  styles.modeButtonText,
                  mode === "login" && styles.modeButtonTextActive,
                ]}
              >
                Sign In
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modeButton,
                mode === "signup" && styles.modeButtonActive,
              ]}
              onPress={() => setMode("signup")}
            >
              <Text
                style={[
                  styles.modeButtonText,
                  mode === "signup" && styles.modeButtonTextActive,
                ]}
              >
                Sign Up
              </Text>
            </TouchableOpacity>
          </View>

          {/* Email/password form */}
          <View style={[styles.form, { width: FORM_WIDTH }]}>
            <TextInput
              style={styles.input}
              placeholder="Email address"
              placeholderTextColor="#999"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
            />
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor="#999"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
            {mode === "signup" && (
              <TextInput
                style={styles.input}
                placeholder="Confirm password"
                placeholderTextColor="#999"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry
              />
            )}

            {mode === "login" && (
              <TouchableOpacity
                style={styles.forgotButton}
                onPress={handleForgotPassword}
                disabled={loading}
              >
                <Text style={styles.forgotText}>Forgot password?</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[styles.submitButton, loading && { opacity: 0.7 }]}
              onPress={handleEmailAuth}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitButtonText}>
                  {mode === "login" ? "Sign In" : "Create Account"}
                </Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Divider */}
          <View style={[styles.dividerRow, { width: FORM_WIDTH }]}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Google button */}
          <TouchableOpacity
            style={[styles.googleButton, { width: FORM_WIDTH }]}
            onPress={signInWithGoogle}
          >
            <AntDesign name="google" size={18} color="#EA4335" />
            <Text style={styles.googleButtonText}>Continue with Google</Text>
          </TouchableOpacity>

          {/* Footer links */}
          <View style={[styles.footerContainer, { width: FORM_WIDTH }]}>
            <Text style={styles.footer}>By continuing you agree to our </Text>
            <TouchableOpacity onPress={() => router.push("/terms")}>
              <Text style={styles.footerLink}>Terms of Service</Text>
            </TouchableOpacity>
            <Text style={styles.footer}> and </Text>
            <TouchableOpacity onPress={() => router.push("/privacy")}>
              <Text style={styles.footerLink}>Privacy Policy</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Platform.OS === "web" ? "#f5f5f5" : "#fff",
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 40,
    paddingHorizontal: Platform.OS === "web" ? 24 : 0,
  },

  // ── Card ─────────────────────────────────────────────────
  card: {
    width: Platform.OS === "web" ? "auto" : "100%",
    backgroundColor: "#fff",
    borderRadius: Platform.OS === "web" ? 20 : 0,
    padding: Platform.OS === "web" ? 40 : 24,
    alignItems: "center",
    ...Platform.select({
      web: { boxShadow: "0 4px 24px rgba(0,0,0,0.08)" },
      default: {},
    }),
  },

  // ── Logo ─────────────────────────────────────────────────
  logoContainer: {
    alignItems: "center",
    marginBottom: 12,
  },
  logo: {
    width: Platform.OS === "web" ? 80 : Math.min(100, SCREEN_WIDTH * 0.25),
    height: Platform.OS === "web" ? 80 : Math.min(100, SCREEN_WIDTH * 0.25),
  },

  // ── Tagline ───────────────────────────────────────────────
  tagline: {
    fontSize: Platform.OS === "web" ? 15 : 14,
    color: "#888",
    textAlign: "center",
    lineHeight: 22,
    fontStyle: "italic",
    marginBottom: 8,
    letterSpacing: 0.2,
  },

  // ── About link ────────────────────────────────────────────
  aboutLink: {
    marginBottom: 20,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  aboutLinkText: {
    fontSize: 13,
    color: "#4A90E8",
    fontWeight: "500",
  },

  // ── Section divider ───────────────────────────────────────
  sectionDivider: {
    height: 1,
    backgroundColor: "#f0f0f0",
    marginBottom: 20,
  },

  // ── Mode toggle ───────────────────────────────────────────
  modeToggle: {
    flexDirection: "row",
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    padding: 4,
    marginBottom: 20,
  },
  modeButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
  },
  modeButtonActive: {
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  modeButtonText: {
    fontSize: 14,
    fontWeight: "500",
    color: "#999",
  },
  modeButtonTextActive: {
    color: "#111",
    fontWeight: "600",
  },

  // ── Form ─────────────────────────────────────────────────
  form: {
    marginBottom: 20,
  },
  input: {
    borderWidth: 1,
    borderColor: "#e0e0e0",
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: "#111",
    marginBottom: 12,
    backgroundColor: "#fafafa",
  },
  forgotButton: {
    alignSelf: "flex-end",
    marginBottom: 16,
    marginTop: -4,
  },
  forgotText: {
    fontSize: 13,
    color: "#666",
  },
  submitButton: {
    backgroundColor: "#111",
    borderRadius: 12,
    padding: 15,
    alignItems: "center",
  },
  submitButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },

  // ── Divider ───────────────────────────────────────────────
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: "#eee",
  },
  dividerText: {
    fontSize: 12,
    color: "#999",
  },

  // ── Google button ─────────────────────────────────────────
  googleButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#e0e0e0",
    borderRadius: 12,
    padding: 14,
    backgroundColor: "#fff",
    gap: 10,
    marginBottom: 24,
  },
  googleButtonText: {
    fontSize: 15,
    color: "#111",
    fontWeight: "500",
  },

  // ── Footer ────────────────────────────────────────────────
  footerContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    gap: 2,
  },
  footer: {
    fontSize: 12,
    color: "#999",
    lineHeight: 18,
  },
  footerLink: {
    fontSize: 12,
    color: "#111",
    fontWeight: "500",
    lineHeight: 18,
  },

  // ── Confirmation ──────────────────────────────────────────
  confirmationCard: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  confirmationIcon: {
    fontSize: 64,
    marginBottom: 24,
  },
  confirmationTitle: {
    fontSize: 24,
    fontWeight: "700",
    color: "#111",
    marginBottom: 16,
    textAlign: "center",
  },
  confirmationText: {
    fontSize: 15,
    color: "#666",
    textAlign: "center",
    lineHeight: 24,
    marginBottom: 32,
    maxWidth: FORM_WIDTH,
  },
  confirmationEmail: {
    color: "#111",
    fontWeight: "600",
  },
});
