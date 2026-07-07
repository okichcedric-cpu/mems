import { useEffect, useState } from "react";
import { View, ActivityIndicator, Platform } from "react-native";
import { Slot, useRouter, useSegments } from "expo-router";
import { Session } from "@supabase/supabase-js";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { supabase } from "../utils/supabase";
import * as Linking from "expo-linking";

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
    // real session via exchangeCodeForSession. This is why the old
    // "access_token in the hash fragment" approach found nothing:
    // that only applies to the older implicit flow, which Supabase
    // isn't using here (confirmed by the "code challenge" warning
    // in the logs, which only fires for PKCE).
    const code = parsed.searchParams.get("code");

    if (code) {
      console.log("[OAuth] Authorization code found — exchanging for session");
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        console.error("[OAuth] exchangeCodeForSession failed:", error.message);
      } else {
        console.log("[OAuth] Session established successfully");
      }
      return;
    }

    // ── Fallback — implicit flow tokens in the hash fragment ────
    // Kept in case flowType is ever switched back to 'implicit'
    const hashParams = new URLSearchParams(parsed.hash.replace("#", ""));
    const access_token = hashParams.get("access_token");
    const refresh_token = hashParams.get("refresh_token");

    if (access_token && refresh_token) {
      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
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

export default function RootLayout() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const segments = useSegments();

  // ── Persistent deep link listener — app lifetime, not per-screen ──
  useEffect(() => {
    if (Platform.OS === "web") return;

    // 1 — Catch the redirect if the app is already running (warm)
    const subscription = Linking.addEventListener("url", ({ url }) => {
      handleAuthRedirect(url);
      if (url.includes("subscription-callback")) {
        router.replace("/");
      }
    });

    // 2 — Catch the redirect if Android cold-started/relaunched the
    // activity because of the intent — this covers the case where the
    // "url" event above never fires because the JS context was fresh
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

  // ── Listen for auth state changes ──────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Handle routing based on session ────────────────────────────
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
      // Not logged in and not on a public page — go to login
      router.replace("/login");
    } else if (session && inAuthGroup) {
      // Logged in but on login page — go to home
      router.replace("/");
    }
  }, [session, segments, loading]);

  // ── Show spinner while checking session ────────────────────────
  if (loading) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
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
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Slot />
    </GestureHandlerRootView>
  );
}