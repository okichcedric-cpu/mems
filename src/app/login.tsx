import * as WebBrowser from "expo-web-browser";
import { makeRedirectUri } from "expo-auth-session";
import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Dimensions,
  Image,
  Animated,
  Linking,
} from "react-native";
import { AntDesign } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { supabase } from "../utils/supabase";

WebBrowser.maybeCompleteAuthSession();

// ── Native redirect URI ──────────────────────────────────────
// Hardcoded to the exact custom scheme rather than relying on
// makeRedirectUri()'s auto-detection. In some standalone/production
// builds, makeRedirectUri() can resolve to Expo's auth proxy
// (auth.expo.io) instead of the app's own scheme — that proxy only
// works inside Expo Go, never in a Play Store build. When that happens
// Supabase finishes login and redirects to a plain https page with no
// way to reopen the native app, which is exactly "stuck on browser".
// A literal "mems://" leaves zero ambiguity.
const NATIVE_REDIRECT = "mems://login";
const redirectTo = Platform.OS === "web"
  ? makeRedirectUri()
  : NATIVE_REDIRECT;

// Note: PKCE code exchange and session handling for the Google OAuth
// redirect is handled exclusively by the persistent listener in
// app/_layout.tsx — it lives at the app root so it survives even if
// Android relaunches the activity, and is the single source of truth
// so the one-time PKCE code only ever gets exchanged once.
const SCREEN_WIDTH = Dimensions.get("window").width;
const IS_WEB = Platform.OS === "web";
const IS_DESKTOP = IS_WEB && SCREEN_WIDTH >= 768;
const FORM_WIDTH = IS_DESKTOP ? 360 : IS_WEB
  ? Math.min(420, SCREEN_WIDTH * 0.9)
  : SCREEN_WIDTH - 48;

type Mode = "login" | "signup";

// ── Uploaded family photos as polaroid thumbnails ─────────
// Positioned in the middle zone — below the logo banner, above the text
// so they never obscure either. Each has a fixed position + tilt.
const POLAROID_PHOTOS = [
  {
    // Top-left — family outdoor dinner
    source: require("@/assets/images/hero/family-dinner.jpg"),
    style: { top: "12%", left: "6%", rotate: "-5deg", width: 136, height: 118 },
  },
  {
    // Top-right — mother and daughter
    source: require("@/assets/images/hero/mother-daughter.jpg"),
    style: { top: "10%", right: "5%", rotate: "6deg", width: 124, height: 134 },
  },
  {
    // Mid-left — Asian mum with kids — raised so clear of text
    source: require("@/assets/images/hero/mum-kids.jpg"),
    style: { top: "44%", left: "8%", rotate: "4deg", width: 140, height: 118 },
  },
  {
    // Mid-right — family in bed
    source: require("@/assets/images/hero/family-bed.jpg"),
    style: { top: "40%", right: "4%", rotate: "-4deg", width: 126, height: 138 },
  },
];

// ── Desktop left hero panel ──────────────────────────────────
function DesktopHeroPanel() {
  const polaroidAnims = useRef(
    POLAROID_PHOTOS.map(() => new Animated.Value(0))
  ).current;

  useEffect(() => {
    POLAROID_PHOTOS.forEach((_, i) => {
      setTimeout(() => {
        Animated.spring(polaroidAnims[i], {
          toValue: 1,
          tension: 60,
          friction: 10,
          useNativeDriver: true,
        }).start();
      }, 200 + i * 160);
    });
  }, []);

  function PolaroidThumb({
    photo,
    anim,
    size = 130,
    height = 110,
  }: {
    photo: typeof POLAROID_PHOTOS[0];
    anim: Animated.Value;
    size?: number;
    height?: number;
  }) {
    return (
      <Animated.View
        style={[
          {
            transform: [
              { rotate: photo.style.rotate },
              { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) },
            ],
            opacity: anim,
          },
        ]}
      >
        <View style={[heroStyles.polaroidCard, { width: size }]}>
          <Image
            source={photo.source}
            style={[heroStyles.polaroidPhoto, { height }]}
            resizeMode="cover"
          />
          <View style={heroStyles.polaroidCaption} />
        </View>
      </Animated.View>
    );
  }

  return (
    <View style={heroStyles.panel}>

      {/* ── Logo row — no banner, just clean on white ── */}
      <View style={heroStyles.logoRow}>
        <Image
          source={require("@/assets/images/icon.png")}
          style={heroStyles.logoIcon}
          resizeMode="contain"
        />
        <Text style={heroStyles.logoName}>Mems</Text>
      </View>

      {/* ── Top row — two photos side by side ── */}
      <View style={heroStyles.topRow}>
        <PolaroidThumb
          photo={POLAROID_PHOTOS[0]}
          anim={polaroidAnims[0]}
          size={148}
          height={126}
        />
        <PolaroidThumb
          photo={POLAROID_PHOTOS[1]}
          anim={polaroidAnims[1]}
          size={140}
          height={132}
        />
      </View>

      {/* ── Middle row — small flanking photos beside text ── */}
      <View style={heroStyles.middleRow}>
        {/* Left small photo */}
        <PolaroidThumb
          photo={POLAROID_PHOTOS[2]}
          anim={polaroidAnims[2]}
          size={108}
          height={90}
        />

        {/* Text block — centred between the two flanking photos */}
        <View style={heroStyles.textBlock}>
          <Text style={heroStyles.headline}>
            Your Digital Album{"\n"}for Life's Most{"\n"}Precious Moments
          </Text>
          <View style={heroStyles.accentLine} />
          <Text style={heroStyles.sub}>
            Keep your memories safe, beautifully organised and shared
            with the people who matter most.
          </Text>
        </View>

        {/* Right small photo */}
        <PolaroidThumb
          photo={POLAROID_PHOTOS[3]}
          anim={polaroidAnims[3]}
          size={108}
          height={94}
        />
      </View>

      {/* ── Pills row ── */}
      <View style={heroStyles.pillsRow}>
        {["📸 Create albums", "🤝 Share moments", "☁️ Safe forever"].map((pill) => (
          <View key={pill} style={heroStyles.pill}>
            <Text style={heroStyles.pillText}>{pill}</Text>
          </View>
        ))}
      </View>

    </View>
  );
}
async function signInWithGoogle() {
  if (IS_WEB) {
    const params = typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
    const redirect = params.get("redirect");
    const redirectTo = redirect
      ? `${window.location.origin}/${redirect}`
      : window.location.origin;

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) {
      console.error("Google sign in error:", error.message);
      window.alert("Sign in with Google failed. Please try again.");
    }
  } else {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: NATIVE_REDIRECT,
        skipBrowserRedirect: true, // we handle opening the browser ourselves below
      },
    });
    if (error) {
      console.error("Google sign in error:", error.message);
      Alert.alert("Error", "Sign in with Google failed. Please try again.");
      return;
    }
    if (data?.url) {
      console.log("[OAuth] Opening browser for Google sign in...");

      // We don't act on this promise's result at all anymore. The
      // persistent listener registered once at the app root (see
      // app/_layout.tsx) is the single source of truth for handling
      // the mems://login redirect and exchanging the PKCE code for a
      // session — it catches the redirect via both the live "url"
      // event AND getInitialURL() in case Android relaunches the
      // activity. Attempting to exchange the same code again here
      // would fail, since PKCE codes are single-use and the root
      // listener typically wins the race and consumes it first.
      //
      // Navigation home is also handled reactively by _layout.tsx —
      // once onAuthStateChange fires with a real session, its routing
      // effect redirects away from /login automatically. No manual
      // router call is needed (or even possible from this module-level
      // function, since it sits outside the component's render scope).
      const result = await WebBrowser.openAuthSessionAsync(data.url, NATIVE_REDIRECT, {
        showInRecents: false,
        toolbarColor: "#111111",
        controlsColor: "#ffffff",
        enableDefaultShareMenuItem: false,
        enableBarCollapsing: true,
      });

      console.log("[OAuth] Browser closed with result type:", result.type);

      try { WebBrowser.dismissBrowser(); } catch {}
    }
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
        // Handle redirect param e.g. from subscription page guest purchase
        if (IS_WEB && typeof window !== "undefined") {
          const params = new URLSearchParams(window.location.search);
          const redirect = params.get("redirect");
          if (redirect) {
            router.replace(`/${redirect}` as any);
            return;
          }
        }
      } else {
        const { error } = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
        });
        if (error) throw error;
        setShowConfirmation(true);
      }
    } catch (error: any) {
      // Log internally, show generic message — never expose Supabase errors
      console.error("Auth error:", error.message);
      const userMessage = mode === "login"
        ? "Sign in failed. Please check your email and password."
        : "Sign up failed. Please try again.";
      if (IS_WEB) {
        window.alert(userMessage);
      } else {
        Alert.alert("Error", userMessage);
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
        }
      );
      if (error) throw error;
      if (IS_WEB) {
        window.alert("Password reset email sent. Check your inbox.");
      } else {
        Alert.alert("Email sent", "Check your inbox for a password reset link.");
      }
    } catch (error: any) {
      console.error("Forgot password error:", error.message);
      if (IS_WEB) {
        window.alert("Could not send reset email. Please try again.");
      } else {
        Alert.alert("Error", "Could not send reset email. Please try again.");
      }
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
        <View style={[
          styles.confirmationCard,
          IS_DESKTOP && styles.confirmationCardDesktop,
        ]}>
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
            onPress={() => { setMode("login"); setShowEmailForm(true); }}
          >
            <Text style={styles.emailToggleText}>Sign in with email</Text>
          </TouchableOpacity>
          <View style={styles.emailToggleDot} />
          <TouchableOpacity
            style={styles.emailToggleButton}
            onPress={() => { setMode("signup"); setShowEmailForm(true); }}
          >
            <Text style={styles.emailToggleText}>Create account</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Mode toggle */}
          <View style={[styles.modeToggle, { width: FORM_WIDTH }]}>
            <TouchableOpacity
              style={[styles.modeButton, mode === "login" && styles.modeButtonActive]}
              onPress={() => { setMode("login"); setConfirmPassword(""); }}
            >
              <Text style={[
                styles.modeButtonText,
                mode === "login" && styles.modeButtonTextActive,
              ]}>
                Sign In
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeButton, mode === "signup" && styles.modeButtonActive]}
              onPress={() => setMode("signup")}
            >
              <Text style={[
                styles.modeButtonText,
                mode === "signup" && styles.modeButtonTextActive,
              ]}>
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
              {loading
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.submitButtonText}>
                    {mode === "login" ? "Sign In" : "Create Account"}
                  </Text>
              }
            </TouchableOpacity>

            {/* Mobile collapse */}
            {!IS_DESKTOP && (
              <TouchableOpacity
                style={styles.collapseButton}
                onPress={() => setShowEmailForm(false)}
              >
                <Text style={styles.collapseText}>← Back to sign in options</Text>
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
        <View style={styles.desktopRight}>
          {authForm}
        </View>
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
    backgroundColor: "#f8f6f2",
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 28,
    justifyContent: "flex-start", // logo pins to top, content flows down
    gap: 24,
    overflow: "hidden",
  },

  // Logo — pinned to top, no banner background
  logoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  logoIcon: {
    width: 42,
    height: 42,
    borderRadius: 0,
  },
  logoName: {
    fontSize: 28,       // matches headline weight and size feel
    fontWeight: "800",  // same as headline
    color: "#111",
    letterSpacing: -0.3, // same as headline
  },

  // Top row — two large photos side by side with space between
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingHorizontal: 8,
  },

  // Middle row — small photo | text | small photo
  middleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },

  // Text lives between the two flanking photos
  textBlock: {
    flex: 1,
  },

  headline: {
    fontSize: 22,
    fontWeight: "800",
    color: "#111",
    lineHeight: 30,
    letterSpacing: -0.3,
    marginBottom: 10,
  },
  accentLine: {
    width: 36,
    height: 3,
    backgroundColor: "#4AE8A0",
    borderRadius: 2,
    marginBottom: 10,
  },
  sub: {
    fontSize: 12,
    color: "#666",
    lineHeight: 18,
  },

  // Pills row at the bottom
  pillsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 4,
  },
  pill: {
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#e0e0e0",
  },
  pillText: {
    fontSize: 11,
    color: "#444",
    fontWeight: "500",
  },

  // ── Polaroid card ─────────────────────────────────────────
  polaroidWrapper: {},
  polaroidCard: {
    backgroundColor: "#fff",
    padding: 7,
    paddingBottom: 0,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: "#e0e0e0",
    ...Platform.select({
      web: { boxShadow: "4px 6px 20px rgba(0,0,0,0.14)" } as any,
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 3, height: 5 },
        shadowOpacity: 0.15,
        shadowRadius: 10,
      },
      android: { elevation: 7 },
    }),
  },
  polaroidPhoto: {
    width: "100%",
    borderRadius: 1,
    overflow: "hidden",
  } as any,
  polaroidCaption: {
    height: 24,
    backgroundColor: "#fff",
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
  footerLink: { fontSize: 12, color: "#111", fontWeight: "500", lineHeight: 18 },

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