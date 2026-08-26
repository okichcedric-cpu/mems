// ── Account-level onboarding flag ────────────────────────────────────────
// Whether the signed-in ACCOUNT has finished (or skipped) the first-time
// walkthrough — backed by a `profiles` row keyed by user id (see
// supabase/migrations/20260826180000_create_profiles_onboarding.sql), not
// device storage. This used to be purely AsyncStorage, deliberately
// device-level: the idea was that the tour walks through app concepts, not
// anything account-specific, so it seemed harmless to key it by device.
// In practice that meant clearing the browser cache, switching browsers,
// or signing in on a new device made a returning user sit through the
// whole tour again — the exact complaint that prompted this rewrite.
//
// AsyncStorage is still used, but now only as a same-device MIRROR of the
// last known server value, purely so a genuinely offline re-open doesn't
// force onboarding again before the network call can succeed. The
// `profiles` row is always the source of truth when reachable.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";

const STORAGE_KEY_PREFIX = "mems-onboarding-seen:";

// Mirrors the last known value in memory — for THIS user id specifically —
// readable synchronously. This is what fixes "Get Started doesn't lead to
// the landing page": app/onboarding.tsx and app/_layout.tsx are different
// mounted components; _layout.tsx's routing effect only re-runs (and
// re-decides where to send you) the instant onboarding.tsx calls
// router.replace("/"), and at that point it needs to already know the
// tour is done. If it only had a fresh Supabase read to go on, it'd have
// to await that inside the same effect — meanwhile the OLD "not seen yet"
// value was still what a previous read had produced, so the effect would
// fire, see "not seen", and immediately router.replace("/onboarding")
// right back, one render before the fresh read resolved. Same class of
// problem as the version counters in utils/collectionsCache.ts, same fix:
// a plain module-level value that updates the instant it changes, no
// await required to read it.
let cachedSeen = false;
let cachedUserId: string | null = null;

// Scoped to a specific user id (rather than a bare boolean) so a second
// account signing in on the same device/tab can never accidentally read
// the first account's cached value before its own fetch has resolved.
export function getCachedOnboardingSeen(userId: string): boolean {
  return cachedUserId === userId && cachedSeen;
}

// Called on sign-out (and before a fresh sign-in's fetch resolves) so a
// stale value from a previous account never leaks into a routing decision
// for whoever's signed in now.
export function resetOnboardingCache(): void {
  cachedSeen = false;
  cachedUserId = null;
}

export async function hasSeenOnboarding(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("onboarding_seen")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;

    const seen = data?.onboarding_seen ?? false;
    cachedSeen = seen;
    cachedUserId = userId;
    // Best-effort local mirror for the offline fallback below — never
    // blocks or throws on its own.
    AsyncStorage.setItem(STORAGE_KEY_PREFIX + userId, seen ? "true" : "false").catch(
      () => {},
    );
    return seen;
  } catch (error: any) {
    console.warn("hasSeenOnboarding error:", error?.message ?? error);
    // Can't reach the server — fall back to the last known LOCAL mirror
    // for this specific account, rather than a blanket guess, so a
    // genuinely offline re-open of a device that has already finished
    // onboarding doesn't force it again.
    try {
      const local = await AsyncStorage.getItem(STORAGE_KEY_PREFIX + userId);
      if (local !== null) {
        const seen = local === "true";
        cachedSeen = seen;
        cachedUserId = userId;
        return seen;
      }
    } catch {
      // fall through to the fail-open default below
    }
    // No local record either — fail open toward NOT showing the tour,
    // consistent with the original device-local version's behaviour: a
    // connectivity hiccup shouldn't force a real returning user through
    // onboarding every time it happens.
    cachedSeen = true;
    cachedUserId = userId;
    return true;
  }
}

export async function markOnboardingSeen(userId: string): Promise<void> {
  // Update the in-memory cache first, synchronously, before the network
  // write even resolves — see the comment above.
  cachedSeen = true;
  cachedUserId = userId;
  AsyncStorage.setItem(STORAGE_KEY_PREFIX + userId, "true").catch(() => {});

  const { error } = await supabase.from("profiles").upsert(
    {
      user_id: userId,
      onboarding_seen: true,
      onboarding_seen_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) {
    console.warn("markOnboardingSeen error:", error.message);
  }
}
