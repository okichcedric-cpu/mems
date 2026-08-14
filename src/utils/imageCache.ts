import { Image } from "expo-image";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

// ── Photo disk-cache eviction ────────────────────────────────────────────
// expo-image's own API only exposes clearDiskCache()/clearMemoryCache(),
// which wipe the ENTIRE cache — there's no built-in "delete this one
// entry" method. getCachePathAsync(cacheKey) does resolve to the actual
// file on disk for a given key, though, so deleting that file directly
// (via expo-file-system) is how targeted eviction actually happens here.
//
// This only matters at all because photos are rendered with a stable
// cacheKey — the raw S3 object key, e.g. `${userId}/${collectionName}/
// ${fileName}` — rather than the presigned URL (see utils/s3.ts). The
// signature and expiry on that URL change every time `list-photos` runs
// even when the underlying photo hasn't, so caching by URL would mean
// every fresh screen load is a guaranteed cache miss. Caching by the
// stable key fixes that, but it also means the cache no longer
// self-invalidates when a presigned URL naturally expires — a deleted
// photo or a revoked share can otherwise keep living in local disk cache
// indefinitely. These functions are the other half of that trade: called
// wherever the app confirms a photo is gone or access was revoked, so the
// cache doesn't quietly outlive the thing it's a cache of.
//
// Deliberately disk-only, not memory cache: there's no per-key memory
// eviction API at all (only the same all-or-nothing clearMemoryCache()),
// and calling that here would evict every other photo currently on
// screen just to remove one. Memory cache is transient anyway — gone the
// moment the app process ends — so the actual privacy-relevant piece
// (data that outlives the session) is the disk cache this targets.

// Mirrors the exact convention used in utils/s3.ts (getSignedThumbnailUrl)
// and the delete-object/list-photos edge functions: same path, with a
// literal "thumbs" segment inserted immediately before the filename.
// Exported because callers rendering a thumbnail need this same derived
// key as the image's cacheKey — thumb and full-res bytes are different
// content living at different S3 keys, so they must never share a cache
// key (that would make expo-image serve one resolution's cached bytes
// under the other's identity, e.g. a blurry thumbnail where the full-res
// photo was expected).
export function deriveThumbKey(fullKey: string): string {
  const parts = fullKey.split("/");
  const fileName = parts.pop()!;
  return [...parts, "thumbs", fileName].join("/");
}

async function evictKey(cacheKey: string): Promise<void> {
  // No native disk cache to reach into on web — expo-image falls back to
  // the browser's own HTTP cache there, which this app has no access to
  // (and doesn't need to: it's origin-scoped and doesn't persist the same
  // way a native on-disk file does).
  if (Platform.OS === "web") return;

  try {
    const path = await Image.getCachePathAsync(cacheKey);
    // Not cached — the common case (most photos a user deletes were
    // never viewed on this particular device) and not an error.
    if (!path) return;
    await FileSystem.deleteAsync(path, { idempotent: true });
  } catch (error: any) {
    // Best-effort, always — a failed eviction should never block the
    // delete/revoke action the user actually asked for. Worst case, one
    // stale image lingers in cache until it's naturally pushed out by
    // expo-image's own size-based LRU limits.
    console.warn(`evictKey error for ${cacheKey}:`, error?.message);
  }
}

// Evicts both the full-resolution and thumbnail cache entries for a
// single photo. Always pass the full-res S3 key (i.e. `photo.key` from a
// list-photos response) — the thumbnail key is derived from it, since a
// photo's thumb is never listed as a separate entry of its own.
export async function evictPhotoFromCache(fullKey: string): Promise<void> {
  await Promise.all([evictKey(fullKey), evictKey(deriveThumbKey(fullKey))]);
}

// Batch version for collection-wide operations — deleting an entire
// collection, or discovering (as a viewer) that a share was revoked.
// Evicts every photo's full-res + thumbnail entries in parallel.
export async function evictPhotosFromCache(fullKeys: string[]): Promise<void> {
  await Promise.all(fullKeys.map((key) => evictPhotoFromCache(key)));
}
