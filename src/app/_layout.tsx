import * as Linking from "expo-linking";
import { Slot, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AuthProvider, useAuth } from "../contexts/AuthContext";
import { supabase } from "../utils/supabase";

// ── OAuth redirect handling ──────────────────────────────────
// Lives at the app root (not inside the login screen) so it survives
// even if Android relaunches the activity/tears down the login
// screen's own JS when redirecting back from the Google OAuth flow.
//
// Why this matters: expo-web-browser's openAuthSessionAsync promise
// is unreliable on Android — it can report "dismiss" even when the
// redirect genuinely succeeded, because the OS itself intercepts the
// mems://login intent and foregrounds the app as a side effect. The
// only reliable way to catch the real result is to listen for the
// redirect URL directly, at a point that lives for the app's entire
// session rather than one function call.
async function handleAuthRedirect(url: string | null) {
  if (!url) return;

  // Mobile subscription payment callback — just needs a refresh/home nav
  if (url.includes("subscription-callback")) {
    console.log("[Deeplink] Subscription callback received");
    return;
  }

  // Google OAuth callback — extract and apply the session
  if (!url.startsWith("mems://login")) return;

  console.log("[OAuth] Handling redirect URL");

  try {
    const parsed = new URL(url);

    // ── PKCE flow (default in current supabase-js) ──────────────
    // Supabase returns an authorization "code" as a query param,
    // e.g. mems://login?code=xxxxx — this must be exchanged for a
    // real session via exchangeCodeForSession.
    const code = parsed.searchParams.get("code");

    if (code) {
      console.log("[OAuth] Authorization code found — exchanging for session");
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        console.error("[OAuth] exchangeCodeForSession failed:", error.message);
      } else {
        console.log("[OAuth] Session established successfully");
        // Note: we don't need to manually update any state here — the
        // AuthProvider's onAuthStateChange listener picks this up
        // automatically and propagates it to the whole app.
      }
      return;
    }

    // ── Fallback — implicit flow tokens in the hash fragment ────
    const hashParams = new URLSearchParams(parsed.hash.replace("#", ""));
    const access_token = hashParams.get("access_token");
    const refresh_token = hashParams.get("refresh_token");

    if (access_token && refresh_token) {
      const { error } = await supabase.auth.setSession({
        access_token,
        refresh_token,
      });
      if (error) {
        console.error("[OAuth] setSession failed:", error.message);
      } else {
        console.log("[OAuth] Session set successfully via fragment tokens");
      }
    } else {
      console.warn("[OAuth] Redirect URL had neither a code nor tokens");
    }
  } catch (err: any) {
    console.error("[OAuth] Failed to parse redirect URL:", err.message);
  }
}

// ── Inner component — consumes AuthContext for routing ────────────
// Must be a separate component from RootLayout because context can
// only be READ below the level of the Provider that supplies it.
function RootLayoutNav() {
  const { session, loading } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  // ── Persistent deep link listener — app lifetime, not per-screen ──
  useEffect(() => {
    if (Platform.OS === "web") return;

    const subscription = Linking.addEventListener("url", ({ url }) => {
      handleAuthRedirect(url);
      if (url.includes("subscription-callback")) {
        router.replace("/");
      }
    });

    Linking.getInitialURL().then((url) => {
      if (url) {
        handleAuthRedirect(url);
        if (url.includes("subscription-callback")) {
          router.replace("/");
        }
      }
    });

    return () => subscription.remove();
  }, []);

  // ── Inject global CSS on web ──────────────────────────────────
  useEffect(() => {
    if (Platform.OS === "web") {
      const style = document.createElement("style");
      style.textContent = `
        * { box-sizing: border-box; }
        body { margin: 0; padding: 0; }
        img {
          -webkit-user-drag: none;
          user-drag: none;
          user-select: none;
          -webkit-user-select: none;
        }
      `;
      document.head.appendChild(style);
      return () => {
        document.head.removeChild(style);
      };
    }
  }, []);

  // ── Handle routing based on session ────────────────────────────
  // This is now the ONLY place in the entire app that makes a routing
  // decision based on auth state — every screen reads the same
  // `session`/`loading` values from AuthContext, so there is no longer
  // any possibility of two parts of the app disagreeing about whether
  // the user is logged in.
  useEffect(() => {
    if (loading) return;
    if (segments.length === 0) return;

    const inAuthGroup = segments[0] === "login";
    const inPublicGroup =
      segments[0] === "terms" ||
      segments[0] === "privacy" ||
      segments[0] === "about" ||
      segments[0] === "subscription" ||
      segments[0] === "subscription-callback" ||
      segments[0] === "delete-account" ||
      segments[0] === "child-safety";

    if (!session && !inAuthGroup && !inPublicGroup) {
      router.replace("/login");
    } else if (session && inAuthGroup) {
      router.replace("/");
    }
  }, [session, segments, loading]);

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "#fff",
        }}
      >
        <ActivityIndicator size="large" color="#111" />
      </View>
    );
  }

  return <Slot />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <RootLayoutNav />
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
