// ── Pending collection upload (native only) ─────────────────────────────
// Persists an in-progress "create collection" attempt across a payment
// flow so it can finish automatically even if the OS kills the app process
// while the in-app payment browser is open. That's not a rare edge case —
// aggressively battery-optimized Android skins (MIUI/Xiaomi in particular)
// are known to reclaim memory from backgrounded apps eagerly, and opening
// a Custom Tab for Pesapal backgrounds Mems for exactly that kind of
// window. When the process gets killed mid-payment, the deep link that
// brings the user back triggers a cold start rather than resuming the
// still-running app, so every bit of in-memory React state — selected
// photos, which action to retry — is gone by the time it comes back up.
//
// Unlike the web version (utils/pendingUpload.ts), this doesn't need to
// persist actual binary data. expo-image-picker's asset URIs already
// point to real files on disk (a cached copy of each picked photo), which
// survive an app process restart on their own — all that needs saving
// here is which files to upload and where they go.

import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "mems-pending-upload-native";
// Same reasoning as the web version — anything older than this is more
// likely an abandoned attempt than a genuine in-flight one.
const MAX_AGE_MS = 60 * 60 * 1000;

export type NativePendingPhoto = {
  uri: string;
  width: number;
  height: number;
};

export type NativePendingCollectionUpload = {
  ownerId: string;
  collectionName: string;
  memoryDateIso: string | null;
  photos: NativePendingPhoto[];
  savedAt: number;
};

// Best-effort throughout, same as the web version — if persistence fails,
// the worst case is falling back to the pre-fix behaviour (reselect
// photos / retap Create), never a blocked purchase.

export async function saveNativePendingUpload(
  data: Omit<NativePendingCollectionUpload, "savedAt">,
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...data, savedAt: Date.now() }),
    );
  } catch (error) {
    console.warn("saveNativePendingUpload error:", error);
  }
}

export async function getNativePendingUpload(): Promise<NativePendingCollectionUpload | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: NativePendingCollectionUpload = JSON.parse(raw);
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      await clearNativePendingUpload();
      return null;
    }
    return parsed;
  } catch (error) {
    console.warn("getNativePendingUpload error:", error);
    return null;
  }
}

export async function clearNativePendingUpload(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn("clearNativePendingUpload error:", error);
  }
}

// Cheap existence check for the cold-launch router in app/_layout.tsx —
// same underlying record, just for callers that only need to decide
// where to route rather than the full payload.
export async function hasNativePendingUpload(): Promise<boolean> {
  return (await getNativePendingUpload()) !== null;
}
