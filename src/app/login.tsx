import { AntDesign } from "@expo/vector-icons";
import { makeRedirectUri } from "expo-auth-session";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
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
const IS_WEB = Platform.OS === "web";
const IS_DESKTOP = IS_WEB && SCREEN_WIDTH >= 768;
const FORM_WIDTH = IS_DESKTOP
  ? 360
  : IS_WEB
    ? Math.min(420, SCREEN_WIDTH * 0.9)
    : SCREEN_WIDTH - 48;

type Mode = "login" | "signup";

// Diverse family images — dark natural lighting, family moments, all races
const FAMILY_IMAGES = [
  // Black family laughing around dinner table — warm dark dining room
  "https://images.unsplash.com/photo-1606041008023-472dfb5e530f?w=900&q=80&fit=crop&crop=center",
  // South Asian family diwali celebration — dark background with warm lamp glow
  "https://images.unsplash.com/photo-1604881988758-f76ad2f7aac1?w=900&q=80&fit=crop&crop=center",
  // White grandparents with grandchildren — cosy dark living room by firelight
  "https://images.unsplash.com/photo-1609220136736-443140cffec6?w=900&q=80&fit=crop&crop=center",
  // Hispanic family outdoor evening — dark dusk sky, warm faces
  "https://images.unsplash.com/photo-1476703993599-0035a21b17a9?w=900&q=80&fit=crop&crop=center",
  // African family portrait — deep studio dark background, joyful
  "https://images.unsplash.com/photo-1511895426328-dc8714191011?w=900&q=80&fit=crop&crop=center",
  // Multiracial family movie night — dark room, soft warm glow on faces
  "https://images.unsplash.com/photo-1585637071663-799845ad5212?w=900&q=80&fit=crop&crop=center",
];

// ── Desktop left hero panel ──────────────────────────────────
function DesktopHeroPanel() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [nextIndex, setNextIndex] = useState(1);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  // Use ref instead of state so interval never resets on load
  const nextLoadedRef = useRef(false);

  // Preload all images on mount so transitions are instant
  useEffect(() => {
    FAMILY_IMAGES.forEach((uri) => {
      if (IS_WEB && typeof window !== "undefined") {
        const img = new (window as any).Image();
        img.src = uri;
      }
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!nextLoadedRef.current) {
        // Mark as loaded anyway after timeout to avoid getting stuck
        nextLoadedRef.current = true;
      }

      Animated.sequence([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.delay(80),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
      ]).start();

      // Swap at the midpoint when opacity is 0
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % FAMILY_IMAGES.length);
        setNextIndex((prev) => (prev + 1) % FAMILY_IMAGES.length);
        nextLoadedRef.current = false;
      }, 800);
    }, 5000); // rotate every 5 seconds

    return () => clearInterval(interval);
  }, []); // ← empty deps — interval never resets

  return (
    <View style={heroStyles.panel}>
      {/* Logo banner */}
      <View style={heroStyles.logoBanner}>
        <Image
          source={require("@/assets/images/icon.png")}
          style={heroStyles.bannerLogo}
          resizeMode="contain"
        />
        <Text style={heroStyles.bannerName}>Mems</Text>
      </View>

      {/* Current image — animates with fade */}
      <Animated.Image
        source={{ uri: FAMILY_IMAGES[currentIndex] }}
        style={[heroStyles.bgImage, { opacity: fadeAnim }]}
        resizeMode="cover"
      />

      {/* Next image — always rendered behind, invisible until swap */}
      <Image
        source={{ uri: FAMILY_IMAGES[nextIndex] }}
        style={[heroStyles.bgImage, { opacity: 0 }]}
        resizeMode="cover"
        onLoad={() => {
          nextLoadedRef.current = true;
        }}
      />

      {/* Dark overlay — bottom gradient using supported properties */}
      <View style={heroStyles.gradientTop} />
      <View style={heroStyles.gradientBottom} />

      {/* Text content */}
      <View style={heroStyles.content}>
        <Text style={heroStyles.headline}>
          Your Digital Album{"\n"}for Life's Most{"\n"}Precious Moments
        </Text>
        <View style={heroStyles.accentLine} />
        <Text style={heroStyles.sub}>
          Keep your memories safe, beautifully{"\n"}
          organised and shared with the people{"\n"}
          who matter most.
        </Text>
        <View style={heroStyles.pills}>
          {["📸 Create albums", "🤝 Share moments", "☁️ Safe forever"].map(
            (pill) => (
              <View key={pill} style={heroStyles.pill}>
                <Text style={heroStyles.pillText}>{pill}</Text>
              </View>
            ),
          )}
        </View>
        <View style={heroStyles.dots}>
          {FAMILY_IMAGES.map((_, i) => (
            <View
              key={i}
              style={[
                heroStyles.dot,
                i === currentIndex && heroStyles.dotActive,
              ]}
            />
          ))}
        </View>
      </View>
    </View>
  );
}
async function signInWithGoogle() {
  if (IS_WEB) {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
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
  const [showEmailForm, setShowEmailForm] = useState(IS_DESKTOP);

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
      if (IS_WEB) {
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
          redirectTo: IS_WEB
            ? `${window.location.origin}/reset-password`
            : redirectTo,
        },
      );
      if (error) throw error;
      if (IS_WEB) {
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

  // ── Confirmation screen ───────────────────────────────────
  if (showConfirmation) {
    return (
      <View style={styles.container}>
        {IS_DESKTOP && <DesktopHeroPanel />}
        {IS_DESKTOP && <View style={styles.separator} />}
        <View
          style={[
            styles.confirmationCard,
            IS_DESKTOP && styles.confirmationCardDesktop,
          ]}
        >
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

  // ── Auth form ────────────────────────────────────────────
  const authForm = (
    <ScrollView
      contentContainerStyle={[
        styles.formScrollContent,
        IS_DESKTOP && styles.formScrollContentDesktop,
      ]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {/* Mobile only — logo */}
      {!IS_DESKTOP && (
        <View style={styles.mobileLogoContainer}>
          <Image
            source={require("@/assets/images/icon.png")}
            style={styles.mobileLogo}
            resizeMode="contain"
          />
          <Text style={styles.mobileTagline}>
            Your life's best moments,{"\n"}all in one place.
          </Text>
          <View style={[styles.sectionDivider, { width: FORM_WIDTH }]} />
        </View>
      )}

      {/* ── Quick links row — About + Pricing ── */}
      <View style={[styles.quickLinksRow, { width: FORM_WIDTH }]}>
        <TouchableOpacity
          style={styles.quickLinkButton}
          onPress={() => router.push("/about")}
          activeOpacity={0.75}
        >
          <Text style={styles.quickLinkIcon}>✦</Text>
          <Text style={styles.quickLinkText}>What is Mems?</Text>
        </TouchableOpacity>

        <View style={styles.quickLinkDivider} />

        <TouchableOpacity
          style={styles.quickLinkButton}
          onPress={() => router.push("/subscription")}
          activeOpacity={0.75}
        >
          <Text style={styles.quickLinkIcon}>📗</Text>
          <Text style={styles.quickLinkText}>View Pricing</Text>
        </TouchableOpacity>
      </View>

      {/* ── Google button — hero ── */}
      <TouchableOpacity
        style={[styles.googleButton, { width: FORM_WIDTH }]}
        onPress={signInWithGoogle}
        activeOpacity={0.85}
      >
        <View style={styles.googleIconWrapper}>
          <AntDesign name="google" size={20} color="#EA4335" />
        </View>
        <Text style={styles.googleButtonText}>Continue with Google</Text>
        <View style={styles.googleArrow}>
          <Text style={styles.googleArrowText}>›</Text>
        </View>
      </TouchableOpacity>

      {/* ── Divider ── */}
      <View style={[styles.dividerRow, { width: FORM_WIDTH }]}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or use email</Text>
        <View style={styles.dividerLine} />
      </View>

      {/* Mobile — collapsed email toggle */}
      {!IS_DESKTOP && !showEmailForm ? (
        <View style={[styles.emailToggleRow, { width: FORM_WIDTH }]}>
          <TouchableOpacity
            style={styles.emailToggleButton}
            onPress={() => {
              setMode("login");
              setShowEmailForm(true);
            }}
          >
            <Text style={styles.emailToggleText}>Sign in with email</Text>
          </TouchableOpacity>
          <View style={styles.emailToggleDot} />
          <TouchableOpacity
            style={styles.emailToggleButton}
            onPress={() => {
              setMode("signup");
              setShowEmailForm(true);
            }}
          >
            <Text style={styles.emailToggleText}>Create account</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
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

          {/* Email inputs */}
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

            {/* Mobile collapse */}
            {!IS_DESKTOP && (
              <TouchableOpacity
                style={styles.collapseButton}
                onPress={() => setShowEmailForm(false)}
              >
                <Text style={styles.collapseText}>
                  ← Back to sign in options
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </>
      )}

      {/* Footer */}
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
    </ScrollView>
  );

  // ── Desktop split layout ─────────────────────────────────
  if (IS_DESKTOP) {
    return (
      <View style={styles.desktopContainer}>
        <DesktopHeroPanel />
        <View style={styles.separator} />
        <View style={styles.desktopRight}>{authForm}</View>
      </View>
    );
  }

  // ── Mobile stacked layout ─────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {authForm}
    </KeyboardAvoidingView>
  );
}

// ── Hero panel styles ────────────────────────────────────────
const heroStyles = StyleSheet.create({
  panel: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
    backgroundColor: "#111",
  },

  // Logo banner — top strip over the image
  logoBanner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 28,
    paddingTop: 24,
    paddingBottom: 16,
    backgroundColor: "rgba(0,0,0,0.62)",
  },
  bannerLogo: {
    width: 36,
    height: 36,
    borderRadius: 0,
  },
  bannerName: {
    fontSize: 20,
    fontWeight: "800",
    color: "#fff",
    letterSpacing: 1,
  },

  // Background cycling images
  bgImage: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%" as any,
    height: "100%" as any,
  },

  // Very light top vignette — just enough to make logo banner readable
  gradientTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "20%" as any,
    backgroundColor: "rgba(0,0,0,0.15)",
    zIndex: 5,
  },
  // No bottom gradient — images are dark enough on their own
  gradientBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 0,
    backgroundColor: "transparent",
    zIndex: 5,
  },

  // Text content — pinned to bottom, sits above both gradient views
  content: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 36,
    paddingBottom: 40,
    paddingTop: 80,
  },
  headline: {
    fontSize: 32,
    fontWeight: "800",
    color: "#fff",
    lineHeight: 42,
    letterSpacing: -0.5,
    marginBottom: 16,
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 12,
  },
  accentLine: {
    width: 44,
    height: 3,
    backgroundColor: "#4AE8A0",
    borderRadius: 2,
    marginBottom: 16,
  },
  sub: {
    fontSize: 14,
    color: "rgba(255,255,255,0.9)",
    lineHeight: 22,
    marginBottom: 24,
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 8,
  },
  pills: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 20,
  },
  pill: {
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  pillText: {
    fontSize: 12,
    color: "rgba(255,255,255,0.85)",
    fontWeight: "500",
  },
  // Image progress dots
  dots: {
    flexDirection: "row",
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.3)",
  },
  dotActive: {
    backgroundColor: "#4AE8A0",
    width: 20,
  },
});

// ── Main styles ──────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: IS_WEB ? "#f5f5f5" : "#fff",
  },
  desktopContainer: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "#fff",
    minHeight: "100%" as any,
  },
  separator: {
    width: 1,
    backgroundColor: "#eee",
  },
  desktopRight: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
  },

  // ── Form scroll ───────────────────────────────────────────
  formScrollContent: {
    flexGrow: 1,
    alignItems: "center",
    paddingVertical: 32,
    paddingHorizontal: IS_WEB ? 24 : 24,
  },
  formScrollContentDesktop: {
    justifyContent: "center",
    minHeight: "100%" as any,
  },

  // ── Mobile logo ───────────────────────────────────────────
  mobileLogoContainer: {
    alignItems: "center",
    marginBottom: 8,
    width: "100%",
  },
  mobileLogo: {
    width: Math.min(100, SCREEN_WIDTH * 0.25),
    height: Math.min(100, SCREEN_WIDTH * 0.25),
    marginBottom: 12,
  },
  mobileTagline: {
    fontSize: 14,
    color: "#888",
    textAlign: "center",
    lineHeight: 22,
    fontStyle: "italic",
    marginBottom: 8,
    letterSpacing: 0.2,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: "#f0f0f0",
    marginBottom: 24,
    marginTop: 8,
  },

  // ── Quick links row ───────────────────────────────────────
  quickLinksRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    backgroundColor: "#f7f7f7",
    borderWidth: 1,
    borderColor: "#eeeeee",
    marginBottom: 24,
    overflow: "hidden",
  },
  quickLinkButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
  quickLinkDivider: {
    width: 1,
    height: 20,
    backgroundColor: "#e0e0e0",
  },
  quickLinkIcon: {
    fontSize: 14,
    color: "#4A90E8",
  },
  quickLinkText: {
    fontSize: 14,
    color: "#4A90E8",
    fontWeight: "600",
  },

  // ── Google button ─────────────────────────────────────────
  googleButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "#e0e0e0",
    paddingVertical: 16,
    paddingHorizontal: 20,
    marginBottom: 20,
    gap: 12,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.08,
        shadowRadius: 8,
      },
      android: { elevation: 3 },
      web: { boxShadow: "0 2px 12px rgba(0,0,0,0.08)" } as any,
    }),
  },
  googleIconWrapper: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#fff5f5",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#fde8e8",
  },
  googleButtonText: {
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    color: "#111",
    letterSpacing: 0.1,
  },
  googleArrow: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#f5f5f5",
    alignItems: "center",
    justifyContent: "center",
  },
  googleArrowText: {
    fontSize: 18,
    color: "#999",
    lineHeight: 22,
  },

  // ── Divider ───────────────────────────────────────────────
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 20,
    gap: 10,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: "#eee",
  },
  dividerText: {
    fontSize: 11,
    color: "#bbb",
    letterSpacing: 0.2,
  },

  // ── Mobile email toggle ───────────────────────────────────
  emailToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginBottom: 24,
  },
  emailToggleButton: { paddingVertical: 6, paddingHorizontal: 4 },
  emailToggleText: {
    fontSize: 14,
    color: "#555",
    fontWeight: "500",
    textDecorationLine: "underline",
  },
  emailToggleDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: "#ccc",
  },

  // ── Mode toggle ───────────────────────────────────────────
  modeToggle: {
    flexDirection: "row",
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
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

  // ── Email form ────────────────────────────────────────────
  form: { marginBottom: 8 },
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
  forgotText: { fontSize: 13, color: "#666" },
  submitButton: {
    backgroundColor: "#111",
    borderRadius: 12,
    padding: 15,
    alignItems: "center",
    marginBottom: 12,
  },
  submitButtonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  collapseButton: { alignItems: "center", paddingVertical: 8, marginBottom: 8 },
  collapseText: { fontSize: 13, color: "#aaa" },

  // ── Footer ────────────────────────────────────────────────
  footerContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    gap: 2,
    marginTop: 16,
  },
  footer: { fontSize: 12, color: "#999", lineHeight: 18 },
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
    backgroundColor: "#fff",
  },
  confirmationCardDesktop: { flex: 1 },
  confirmationIcon: { fontSize: 64, marginBottom: 24 },
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
  },
  confirmationEmail: { color: "#111", fontWeight: "600" },
});
