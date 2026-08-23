import { Caveat_700Bold, useFonts } from "@expo-google-fonts/caveat";
import * as Sentry from "@sentry/react-native";
import * as Linking from "expo-linking";
import { Slot, useRouter, useSegments } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AuthProvider, useAuth } from "../contexts/AuthContext";
import { hasNativePendingUpload } from "../utils/pendingUploadNative";
import { supabase } from "../utils/supabase";

// ── Crash reporting ───────────────────────────────────────────
// Initialized once, at module load, before anything else in the app
// runs — this is what lets it catch crashes that happen very early
// (including native-level ones on the payment/deep-link flows that
// have been hard to diagnose from user reports alone).
Sentry.init({
  dsn: "https://62df84b446a4ee3f48fb812535397c30@o4511895075684352.ingest.de.sentry.io/4511895086235728",
  // Off during local dev — otherwise every Metro fast-refresh, Expo Go
  // hiccup, and local console.error while iterating gets reported
  // alongside genuine user crashes, making the dashboard far less useful
  // for actually triaging what real users hit.
  enabled: !__DEV__,
  environment: __DEV__ ? "development" : "production",
  // Adds more context data to events (IP address, cookies, user, etc.)
  // For more information, visit: https://docs.sentry.io/platforms/react-native/data-management/data-collected/
  sendDefaultPii: true,
  // Enable Logs
  enableLogs: true,
  // Configure Session Replay
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1,
  integrations: [Sentry.mobileReplayIntegration()],
  // uncomment the line below to enable Spotlight (https://spotlightjs.com)
  // spotlight: __DEV__,
});

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
// Returns which kind of redirect this was (so the caller can navigate
// appropriately), or null if the URL wasn't one we handle / the exchange
// failed.
async function handleAuthRedirect(
  url: string | null,
): Promise<"oauth" | "recovery" | null> {
  if (!url) return null;

  // Mobile subscription payment callback — just needs a refresh/home nav
  if (url.includes("subscription-callback")) {
    console.log("[Deeplink] Subscription callback received");
    return null;
  }

  // Google OAuth callback vs. password-recovery callback — both carry a
  // PKCE code/tokens the same way, they just land on different screens
  // afterwards (home vs. the reset-password form).
  const isRecovery = url.startsWith("mems://reset-password");
  const isOAuth = url.startsWith("mems://login");
  if (!isRecovery && !isOAuth) return null;

  console.log(
    isRecovery
      ? "[Auth] Handling password recovery redirect"
      : "[OAuth] Handling redirect URL",
  );

  try {
    const parsed = new URL(url);

    // ── PKCE flow (default in current supabase-js) ──────────────
    // Supabase returns an authorization "code" as a query param,
    // e.g. mems://login?code=xxxxx — this must be exchanged for a
    // real session via exchangeCodeForSession.
    const code = parsed.searchParams.get("code");

    if (code) {
      console.log("[Auth] Authorization code found — exchanging for session");
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        console.error("[Auth] exchangeCodeForSession failed:", error.message);
        return null;
      }
      console.log("[Auth] Session established successfully");
      // Note: we don't need to manually update any state here — the
      // AuthProvider's onAuthStateChange listener picks this up
      // automatically and propagates it to the whole app.
      return isRecovery ? "recovery" : "oauth";
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
        console.error("[Auth] setSession failed:", error.message);
        return null;
      }
      console.log("[Auth] Session set successfully via fragment tokens");
      return isRecovery ? "recovery" : "oauth";
    }

    console.warn("[Auth] Redirect URL had neither a code nor tokens");
    return null;
  } catch (err: any) {
    console.error("[Auth] Failed to parse redirect URL:", err.message);
    return null;
  }
}

// ── Inner component — consumes AuthContext for routing ────────────
// Must be a separate component from RootLayout because context can
// only be READ below the level of the Provider that supplies it.
function RootLayoutNav() {
  const { session, loading } = useAuth();
  // Handwritten-look font used for collection names on the home screen
  // (see app/index.tsx's polaroidCard) — loaded once, here at the root,
  // so every screen can already rely on it being available rather than
  // each screen re-loading (and re-flashing a fallback font) on its own.
  const [fontsLoaded] = useFonts({ Caveat_700Bold });
  const router = useRouter();
  const segments = useSegments();
  // Deep-link handlers below run inside a mount-once effect ([] deps), so
  // they'd otherwise close over whatever `segments` was at that very
  // first render — a ref kept in sync on every render is what lets them
  // see the CURRENT route instead of a stale snapshot from app launch.
  const segmentsRef = useRef(segments);
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  // ── Persistent deep link listener — app lifetime, not per-screen ──
  useEffect(() => {
    if (Platform.OS === "web") return;

    // Some Android launch/Custom-Tab configurations can deliver the same
    // subscription-callback link to both handlers below — the live "url"
    // listener AND getInitialURL() — even on a genuine cold start where
    // both fire for the one intent that launched the app. This flag lets
    // whichever one sees it first "claim" it, so the other doesn't also
    // act on the same event.
    let claimedSubscriptionCallback = false;

    const subscription = Linking.addEventListener("url", ({ url }) => {
      handleAuthRedirect(url).then((result) => {
        if (result === "recovery") router.replace("/reset-password");
      });
      // ── Subscription payment callback (app already running) ──────
      // Pesapal redirects back to mems://subscription-callback inside
      // the in-app browser that PaywallModal opened via
      // WebBrowser.openBrowserAsync(). The OS intercepts that custom
      // scheme with its own "Open in Mems?" prompt and, on confirming,
      // fires this very listener — while PaywallModal is STILL awaiting
      // that openBrowserAsync() call to resolve.
      //
      // This used to force `router.replace("/")` here, which unmounts
      // whatever screen opened the paywall (e.g. new-collection) right
      // out from under PaywallModal's in-flight await — its
      // continuation (sync-subscription + onSubscribed/onDismiss) would
      // then run against a torn-down component, which is what crashed.
      //
      // Calling dismissBrowser() instead closes the in-app browser
      // through the SAME mechanism PaywallModal is already waiting on,
      // so openBrowserAsync() resolves cleanly and PaywallModal's own
      // completion logic drives what happens next — no competing
      // navigation, and the calling screen (with its selected photos
      // still in memory) never unmounts.
      if (url.includes("subscription-callback")) {
        claimedSubscriptionCallback = true;
        WebBrowser.dismissBrowser();
      }
    });

    Linking.getInitialURL().then(async (url) => {
      if (url) {
        handleAuthRedirect(url).then((result) => {
          if (result === "recovery") router.replace("/reset-password");
        });
        if (url.includes("subscription-callback") && !claimedSubscriptionCallback) {
          // If we're ALREADY sitting on new-collection, there's nothing
          // to navigate to — this really was just the live listener
          // above handling things (or about to), not a genuine cold
          // start, and forcing a replace onto the exact screen that's
          // mid-payment is exactly the "unmount out from under a pending
          // continuation" bug this whole mechanism exists to avoid.
          // Only navigate when we're somewhere else, which is the actual
          // signal that this is a fresh launch (the app process was
          // killed while the payment browser was open — aggressively
          // battery-optimized Android skins do this readily, but even
          // stock Android can under real memory pressure) rather than a
          // duplicate delivery of an event the live listener already
          // caught.
          const alreadyOnNewCollection = segmentsRef.current
            .join("/")
            .includes("new-collection");
          if (!alreadyOnNewCollection) {
            const hasPending = await hasNativePendingUpload();
            router.replace(hasPending ? "/new-collection" : "/");
          }
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
    // Note: no longer guarding on segments.length === 0 here. That guard
    // was meant to skip the check while segments are still being computed,
    // but an empty array is also the CORRECT, final value Expo Router
    // returns for the root "/" route — not just a "not ready yet" state.
    // Skipping the check for that case meant visiting "/" directly (e.g.
    // a fresh browser with no session) never got redirected to /login at
    // all — the home screen just rendered regardless of session state.
    // `loading` above is the actual "not ready yet" gate we need.

    const inAuthGroup = segments[0] === "login";
    const inPublicGroup =
      segments[0] === "terms" ||
      segments[0] === "privacy" ||
      segments[0] === "about" ||
      segments[0] === "subscription" ||
      segments[0] === "subscription-callback" ||
      segments[0] === "delete-account" ||
      segments[0] === "reset-password" ||
      segments[0] === "child-safety";

    if (!session && !inAuthGroup && !inPublicGroup) {
      router.replace("/login");
    } else if (session && inAuthGroup) {
      router.replace("/");
    }
  }, [session, segments, loading]);

  if (loading || !fontsLoaded) {
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

function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <RootLayoutNav />
      </AuthProvider>
    </GestureHandlerRootView>
  );
}

// Sentry.wrap adds the touch-event breadcrumbs, native crash tracking,
// and (with mobileReplayIntegration above) session replay hookups on top
// of the plain Sentry.init above — this is what the RN SDK expects
// wrapping the true app root, so it stays here rather than deeper in the
// tree where a screen-level error boundary would normally go.
export default Sentry.wrap(RootLayout);
