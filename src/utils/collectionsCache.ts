// Tiny module-level version counter.
//
// app/index.tsx (the home screen) skips refetching its collections list
// on refocus (e.g. pressing back/home from a collection) as long as
// nothing has changed since its last fetch this session — see
// getCachedHomeCollections/setCachedHomeCollections below for the actual
// cache this guards, and why it also has to live at module level rather
// than a component-scoped ref (turns out `router.replace("/")` — used by
// more than one "go home" button in this app — actually unmounts and
// remounts the destination screen rather than reusing whatever instance
// was already in the stack; see _layout.tsx's own comment about this
// same behavior biting an earlier fix. A ref tied to the component
// instance doesn't survive that remount, so the freshness check would
// silently always miss whenever home was reached that way instead of via
// router.back()). That optimization only holds as long as nothing
// actually mutated while the user was away from the home screen.
// Anything that changes a collection's data from elsewhere in the app —
// creating one, adding or deleting a photo, renaming, deleting the whole
// collection — must call bumpCollectionsVersion() so the home screen's
// freshness check fails and it does a real refetch next time it's
// focused, instead of quietly showing stale
// photoCount/previewUrls/collection names indefinitely.
//
// Deliberately not React state / context: this only needs to be read
// once per focus event on a single screen, and a plain module-level
// value avoids re-rendering or re-subscribing anything just to carry one
// integer between unrelated screens.
let version = 0;

export function bumpCollectionsVersion(): void {
  version += 1;
}

export function getCollectionsVersion(): number {
  return version;
}

// ── Per-collection version + photo cache ─────────────────────────────
// The home screen is a single, persistent screen instance that
// expo-router keeps alive and merely refocuses when you navigate back
// to it — so its own state can just sit there unchanged when nothing's
// stale. app/collection/[id].tsx isn't like that: leaving a collection
// and opening it (or a different one) again is a fresh push, which
// mounts a brand-new component instance with its state reset to
// defaults. That's what made re-opening a collection you'd just viewed
// feel like a full reload — the mount effect had no way to know it
// already had this exact data seconds ago.
//
// This is the equivalent of lastFetchRef, but living at module level
// (outside any component) so it survives the remount. Keyed per
// collection (ownerId + name) so mutating one collection never
// invalidates another's cached photos.
type CollectionKey = string;

function keyOf(ownerId: string, name: string): CollectionKey {
  return `${ownerId}::${name}`;
}

const collectionVersions = new Map<CollectionKey, number>();

export function getCollectionVersion(ownerId: string, name: string): number {
  return collectionVersions.get(keyOf(ownerId, name)) ?? 0;
}

// Call this from app/collection/[id].tsx whenever an action taken on
// THAT screen mutates the collection's photos or identity (upload,
// delete photo, rename, delete collection, or discovering access was
// revoked) — never from code that's about to refetch on its own behalf
// only (that alone doesn't need the cache invalidated for anyone else).
export function bumpCollectionVersion(ownerId: string, name: string): void {
  const key = keyOf(ownerId, name);
  collectionVersions.set(key, (collectionVersions.get(key) ?? 0) + 1);
  // What changed here also affects the home screen's photoCount/preview
  // thumbnails for this same collection — keep that in sync too.
  bumpCollectionsVersion();
}

// Structurally compatible with app/collection/[id].tsx's local `Photo`
// type (not imported/exported — TS structural typing makes that fine).
export type CachedCollectionPhoto = {
  key: string;
  url: string;
  thumbUrl?: string;
  width: number;
  height: number;
};

type CollectionPhotoCacheEntry = {
  photos: CachedCollectionPhoto[];
  version: number;
};

const collectionPhotoCache = new Map<CollectionKey, CollectionPhotoCacheEntry>();

// Returns undefined on a genuine miss OR a stale hit (version moved on
// since this was cached) — callers should treat both the same way: do a
// real fetch.
export function getCachedCollectionPhotos(
  ownerId: string,
  name: string,
): CachedCollectionPhoto[] | undefined {
  const key = keyOf(ownerId, name);
  const entry = collectionPhotoCache.get(key);
  if (!entry) return undefined;
  if (entry.version !== getCollectionVersion(ownerId, name)) return undefined;
  return entry.photos;
}

// Write-through: call this every time fetchPhotos() succeeds, not just
// on the initial mount fetch, so later mutation-triggered refetches
// (upload/delete/rename) keep the cache current for the next remount.
export function setCachedCollectionPhotos(
  ownerId: string,
  name: string,
  photos: CachedCollectionPhoto[],
): void {
  collectionPhotoCache.set(keyOf(ownerId, name), {
    photos,
    version: getCollectionVersion(ownerId, name),
  });
}

// Drops any cached photos for this collection outright, regardless of
// version bookkeeping — used when the collection itself is gone
// (deleted) or access to it was just revoked, so a stray revisit (e.g.
// browser back/forward, a stale deep link) can't hydrate from
// no-longer-valid cached data without ever re-checking the server.
export function dropCollectionCache(ownerId: string, name: string): void {
  const key = keyOf(ownerId, name);
  collectionPhotoCache.delete(key);
  collectionVersions.delete(key);
  // Same reasoning as bumpCollectionVersion — the home screen also
  // needs to know something changed here.
  bumpCollectionsVersion();
}

// ── Wipe everything on sign-out ───────────────────────────────────────
// The cache above is keyed by (ownerId, collection name) only — there's
// no notion of "who is currently viewing" baked into that key, because
// for the OWNER's own collections there doesn't need to be. But on a
// shared device, if account A views their own collection (caching it
// under A's ownerId), signs out, and a different account B signs in and
// is then given — or guesses — a URL to that same collection, the
// version-match check in getCachedCollectionPhotos would see a "fresh"
// hit and hydrate A's photos for B WITHOUT ever calling list-photos —
// meaning the server-side authorization check (the 403 that's supposed
// to gate a non-owner, non-shared viewer) never happens at all. Session
// changes are exactly the boundary where that risk appears, so
// AuthContext.tsx calls this every time the session goes to null
// (sign-out, session expiry) — cheap and safe to over-call, since an
// empty cache just means the next visit does a normal real fetch.
export function clearAllCollectionCaches(): void {
  collectionPhotoCache.clear();
  collectionVersions.clear();
  homeCache = null;
  previousSharedCollections = [];
}

// ── Home screen's own collections list ────────────────────────────────
// Same idea as the per-collection photo cache above, applied to
// app/index.tsx's full grid (owned + shared collections, each with up to
// 3 preview thumbnails). Only one of these ever exists at a time — home
// isn't parameterized by anything, so a single slot (not a Map) is
// enough. Keyed by userId so a different signed-in user never reads
// another's cached list (belt-and-suspenders alongside
// clearAllCollectionCaches() clearing this on sign-out too).
type CachedHomeCollection = {
  name: string;
  previewUrls: { url: string; key: string }[];
  photoCount: number;
  ownerId: string;
  ownerEmail?: string;
  isShared?: boolean;
};

type HomeCacheEntry = {
  userId: string;
  collections: CachedHomeCollection[];
  version: number;
};

let homeCache: HomeCacheEntry | null = null;

// Same miss-or-stale contract as getCachedCollectionPhotos.
export function getCachedHomeCollections(
  userId: string,
): CachedHomeCollection[] | undefined {
  if (!homeCache) return undefined;
  if (homeCache.userId !== userId) return undefined;
  if (homeCache.version !== getCollectionsVersion()) return undefined;
  return homeCache.collections;
}

export function setCachedHomeCollections(
  userId: string,
  collections: CachedHomeCollection[],
): void {
  homeCache = { userId, collections, version: getCollectionsVersion() };
}

// ── Previous shared-collections snapshot, for revocation diffing ───────
// app/index.tsx compares each fresh fetch's shared-with-me collections
// against whatever it saw last time, to catch ones that disappeared
// (owner revoked the share or deleted the collection) and evict their
// cached preview thumbnails. That comparison needs to survive the same
// remounts as everything else above — a component-scoped ref would
// silently reset to empty on a router.replace("/") remount, and an empty
// "previous" snapshot means the diff always finds nothing missing, so
// evictions would just quietly stop firing right after a remount.
// Deliberately NOT version-gated like getCachedHomeCollections — this
// needs to return whatever was last seen regardless of whether the
// version has since moved on (that's exactly the situation where a real
// fetch, and therefore this diff, is about to happen).
let previousSharedCollections: CachedHomeCollection[] = [];

export function getPreviousSharedCollections(): CachedHomeCollection[] {
  return previousSharedCollections;
}

export function setPreviousSharedCollections(
  collections: CachedHomeCollection[],
): void {
  previousSharedCollections = collections;
}
