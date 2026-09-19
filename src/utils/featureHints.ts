// ── One-time feature-discovery tips ──────────────────────────────────
// Sibling to utils/onboarding.ts, but deliberately lighter weight: the
// account-level onboarding flag exists because that's a mandatory,
// multi-screen first-run walkthrough — re-showing it after a device
// switch was a genuinely bad experience worth a `profiles` column and a
// server round trip to fix. A feature hint like "long-press to select
// multiple photos" is a single small dismissible sticker, not a gate on
// using the app, so the cost of it re-appearing once after a browser
// change or reinstall is low. Plain device-local AsyncStorage is enough
// here — no migration, no account sync, and it fails open (never shows
// again) rather than fail closed (shows forever) if storage itself is
// ever unavailable, since annoying a user repeatedly is worse than a
// tip they occasionally miss.
//
// Keyed per-hint (not one shared flag) so introducing a second tip later
// for a different feature doesn't require touching this one.
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY_PREFIX = "mems-hint-seen:";

async function hasSeenHint(hintKey: string): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(STORAGE_KEY_PREFIX + hintKey);
    return value === "true";
  } catch (error: any) {
    console.warn("hasSeenHint error:", error?.message ?? error);
    // Fail open — treat storage errors as "already seen" so a broken
    // AsyncStorage read can't cause the tip to nag on every open.
    return true;
  }
}

async function markHintSeen(hintKey: string): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY_PREFIX + hintKey, "true");
  } catch (error: any) {
    console.warn("markHintSeen error:", error?.message ?? error);
    // Best-effort — worst case the tip shows again next open, which is
    // a minor annoyance rather than something worth surfacing further.
  }
}

const MULTISELECT_HINT_KEY = "multiselect-photos";

export function hasSeenMultiSelectHint(): Promise<boolean> {
  return hasSeenHint(MULTISELECT_HINT_KEY);
}

export function markMultiSelectHintSeen(): Promise<void> {
  return markHintSeen(MULTISELECT_HINT_KEY);
}
