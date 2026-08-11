// ── Pending collection upload (web only) ────────────────────────────────────
// Persists an in-progress "create collection" attempt across a payment
// redirect. On mobile web, window.open() for the Pesapal popup is
// frequently blocked (or simply behaves like a same-tab navigation on some
// mobile browsers regardless), which falls back to a same-tab
// `window.location.href` redirect — a real page navigation that wipes all
// in-memory React state, including the photos the user had already picked.
// Those only ever existed as blob: URLs / in-memory File objects, which die
// the instant the page navigates away.
//
// IndexedDB is the only web storage that can hold actual binary file data
// across that navigation — localStorage/sessionStorage only hold strings,
// and base64-encoding several full-resolution photos into JSON would be
// both slow and likely to blow a browser's storage quota.
//
// Native isn't affected by the same failure mode — see the fix in
// app/_layout.tsx, which keeps the screen that opened the paywall mounted
// (and its in-memory state intact) across the whole payment flow instead of
// forcing a navigation when the Pesapal callback comes in.

const DB_NAME = "mems-pending-upload";
const STORE_NAME = "pending";
const RECORD_KEY = "current";
// If a draft has been sitting untouched this long, treat it as abandoned
// (e.g. the user gave up mid-payment) rather than silently resurrecting it
// on some unrelated later visit.
const MAX_AGE_MS = 60 * 60 * 1000;

export type PendingPhoto = {
  name: string;
  blob: Blob;
  width: number;
  height: number;
};

export type PendingCollectionUpload = {
  ownerId: string;
  collectionName: string;
  memoryDateIso: string | null;
  photos: PendingPhoto[];
  savedAt: number;
};

function isSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Best-effort by design throughout this file — if persistence fails for
// any reason, the worst case is the pre-existing behaviour (the user has
// to reselect photos after payment), never a blocked purchase.

export async function savePendingCollectionUpload(
  data: Omit<PendingCollectionUpload, "savedAt">,
): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(
        { ...data, savedAt: Date.now() },
        RECORD_KEY,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (error) {
    console.warn("savePendingCollectionUpload error:", error);
  }
}

export async function getPendingCollectionUpload(): Promise<PendingCollectionUpload | null> {
  if (!isSupported()) return null;
  try {
    const db = await openDb();
    const result = await new Promise<PendingCollectionUpload | null>(
      (resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      },
    );
    db.close();

    if (result && Date.now() - result.savedAt > MAX_AGE_MS) {
      await clearPendingCollectionUpload();
      return null;
    }
    return result;
  } catch (error) {
    console.warn("getPendingCollectionUpload error:", error);
    return null;
  }
}

export async function clearPendingCollectionUpload(): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (error) {
    console.warn("clearPendingCollectionUpload error:", error);
  }
}

// Lets the resume flow flag "there IS a pending upload, but redirect
// somewhere else first" without a full DB round trip — cheap synchronous
// check for subscription-callback.tsx to decide where to send the user.
export function markPendingUploadHint(): void {
  try {
    sessionStorage.setItem("mems-has-pending-upload", "1");
  } catch {}
}

export function hasPendingUploadHint(): boolean {
  try {
    return sessionStorage.getItem("mems-has-pending-upload") === "1";
  } catch {
    return false;
  }
}

export function clearPendingUploadHint(): void {
  try {
    sessionStorage.removeItem("mems-has-pending-upload");
  } catch {}
}
