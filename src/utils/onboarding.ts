// ── First-time onboarding flag ──────────────────────────────────────────
// A single, device-level "has this device finished (or skipped) the
// onboarding tour" flag — deliberately NOT keyed by user id. The tour
// walks through app *concepts* (collections, sharing, the photo viewer),
// not anything account-specific, so a second account signing in on the
// same device/browser shouldn't have to sit through it again.
// AsyncStorage's own web implementation (backed by localStorage) makes
// this work identically on native and web with the same code, same as
// utils/pendingUploadNative.ts.
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "mems-onboarding-seen";

// Mirrors the AsyncStorage value in memory, readable synchronously — this
// is what fixes "Get Started doesn't lead to the landing page". app/
// onboarding.tsx and app/_layout.tsx are different mounted components;
// _layout.tsx's routing effect only re-runs (and re-decides where to
// send you) the instant onboarding.tsx calls router.replace("/"), and at
// that point it needs to already know the tour is done. If it only had
// AsyncStorage to go on, it'd have to await a fresh read inside that same
// effect — meanwhile the OLD "not seen yet" value was still what a
// previous read had produced, so the effect would fire, see "not seen",
// and immediately router.replace("/onboarding") right back, one render
// before the fresh read resolved. Same class of problem as the version
// counters in utils/collectionsCache.ts, same fix: a plain module-level
// value that updates the instant it changes, no await required to read it.
let cachedSeen = false;

export function getCachedOnboardingSeen(): boolean {
  return cachedSeen;
}

export async function hasSeenOnboarding(): Promise<boolean> {
  try {
    const seen = (await AsyncStorage.getItem(STORAGE_KEY)) === "true";
    cachedSeen = seen;
    return seen;
  } catch (error) {
    console.warn("hasSeenOnboarding error:", error);
    // Fail open toward NOT showing the tour — a storage hiccup shouldn't
    // force a returning user back through onboarding every time it errors.
    cachedSeen = true;
    return true;
  }
}

export async function markOnboardingSeen(): Promise<void> {
  // Update the in-memory cache first, synchronously, before the
  // AsyncStorage write even resolves — see the comment above.
  cachedSeen = true;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, "true");
  } catch (error) {
    console.warn("markOnboardingSeen error:", error);
  }
}
