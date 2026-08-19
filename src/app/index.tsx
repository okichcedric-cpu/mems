import ShimmerPlaceholder from "@/components/ShimmerPlaceholder";
import { useAuth } from "@/contexts/AuthContext";
import { Ionicons } from "@expo/vector-icons";
import { Session } from "@supabase/supabase-js";
import { Image } from "expo-image";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Platform,
  RefreshControl,
  Image as RNImage,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { showAlert } from "../utils/alert";
import {
  dropCollectionCache,
  getCachedHomeCollections,
  getPreviousSharedCollections,
  setCachedHomeCollections,
  setPreviousSharedCollections,
} from "../utils/collectionsCache";
import { deriveThumbKey, evictPhotosFromCache } from "../utils/imageCache";
import { deleteCollection } from "../utils/s3";
import { getSharedCollections } from "../utils/sharing";
import { checkSubscription, SubscriptionStatus } from "../utils/subscription";
import { supabase } from "../utils/supabase";

const SCREEN_WIDTH = Dimensions.get("window").width;
const COLUMN_WIDTH = (SCREEN_WIDTH - 48) / 2;

// url paired with the stable S3 key it corresponds to (whichever of
// thumbUrl/url was actually chosen below) — expo-image needs that key,
// not the presigned url itself, as its cacheKey. See utils/imageCache.ts.
type PreviewPhoto = { url: string; key: string };

type Collection = {
  name: string;
  previewUrls: PreviewPhoto[];
  photoCount: number;
  ownerId: string;
  ownerEmail?: string;
  isShared?: boolean;
};

// Module-level, NOT defined inside CollectionsPage — this used to be a
// `const CollectionCollage = (...) => (...)` declared inside the
// component's function body, which meant a brand new function (and
// therefore a brand new component TYPE, as far as React's reconciler is
// concerned) was created on every single render of CollectionsPage. Any
// unrelated state update — e.g. checkSubscription() resolving and
// calling setSubscriptionStatus() with a freshly constructed object,
// which happens on every single focus, cache hit or not — triggered a
// re-render that hoisted the CollectionCollage identity, so React tore
// down and rebuilt every <Image> inside every visible collage. That
// full unmount/remount is what produced the visible "double load": the
// instant cache-hit paint, immediately followed by every thumbnail
// flashing back to its shimmer placeholder and re-appearing a moment
// later. Purely a React reconciliation issue — nothing to do with
// network requests or the image disk/browser cache — which is exactly
// why it showed up identically on native and web. Giving this component
// a stable, module-level identity means the same underlying <Image>
// instances persist across re-renders, so unrelated state changes
// elsewhere on the screen no longer touch it at all.
const CollectionCollage = ({
  photos,
  name,
}: {
  photos: PreviewPhoto[];
  name: string;
}) => (
  <View style={StyleSheet.absoluteFill}>
    <View style={styles.collageContainer}>
      <View style={styles.collageLeft}>
        {photos[0] ? (
          <View style={StyleSheet.absoluteFill}>
            <ShimmerPlaceholder />
            <Image
              source={{
                uri: photos[0].url,
                // Stable S3 key, not the presigned url — see
                // utils/imageCache.ts for why the url alone would defeat
                // the disk cache across sessions. Lives on the `source`
                // object itself, not as a top-level <Image> prop.
                cacheKey: photos[0].key,
              }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={photos[0].key}
              transition={{ duration: 300, effect: "cross-dissolve" }}
              pointerEvents="none"
            />
          </View>
        ) : (
          <ShimmerPlaceholder />
        )}
      </View>
      <View style={styles.collageRight}>
        <View style={styles.collageRightTop}>
          {photos[1] ? (
            <View style={StyleSheet.absoluteFill}>
              <ShimmerPlaceholder />
              <Image
                source={{ uri: photos[1].url, cacheKey: photos[1].key }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                cachePolicy="memory-disk"
                recyclingKey={photos[1].key}
                transition={{ duration: 300, effect: "cross-dissolve" }}
                pointerEvents="none"
              />
            </View>
          ) : (
            <ShimmerPlaceholder />
          )}
        </View>
        <View style={styles.collageRightBottom}>
          {photos[2] ? (
            <View style={StyleSheet.absoluteFill}>
              <ShimmerPlaceholder />
              <Image
                source={{ uri: photos[2].url, cacheKey: photos[2].key }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                cachePolicy="memory-disk"
                recyclingKey={photos[2].key}
                transition={{ duration: 300, effect: "cross-dissolve" }}
                pointerEvents="none"
              />
            </View>
          ) : (
            <ShimmerPlaceholder />
          )}
        </View>
      </View>
    </View>
    <View style={styles.collageOverlay}>
      <Text style={styles.collageName} numberOfLines={1}>
        {name}
      </Text>
    </View>
  </View>
);

const LEFT_HEIGHTS = [1.35, 1.0, 1.2, 1.0, 1.35, 1.1];
const RIGHT_HEIGHTS = [1.0, 1.35, 1.0, 1.2, 1.1, 1.35];

export default function CollectionsPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // ── Single source of truth ──────────────────────────────────
  // Previously this screen ran its OWN independent getSession() call
  // on mount, completely separate from the session check in
  // _layout.tsx. That created a race condition: _layout.tsx could
  // correctly determine the user was logged in (so it let them see
  // this screen), while THIS screen's own separate getSession() call
  // raced and returned null at that exact moment — silently skipping
  // fetchCollections() entirely and leaving a blank, "logged in but
  // empty" home screen. This was the root cause of the blank homepage
  // bug after app updates specifically, since storage read timing can
  // shift right after an update installs.
  //
  // Now this screen simply reads the already-validated session from
  // AuthContext — there is only ever one source of truth for the
  // whole app, set once in AuthProvider and shared everywhere.
  const { session } = useAuth();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [subscriptionStatus, setSubscriptionStatus] =
    useState<SubscriptionStatus | null>(null);

  // ── Fetches data on focus — the ONLY place this screen fetches ──
  //
  // Depends on `session?.user?.id` (a plain string), NOT on `session`
  // itself. Supabase constructs a brand new session object on every
  // auth event — including routine TOKEN_REFRESHED events that happen
  // automatically in the background and don't represent any real
  // change. Depending on the object's identity meant every refresh
  // re-triggered this effect: loading flipped back to true, the grid
  // disappeared, then reappeared once the refetch finished — a visible
  // flicker on every single token refresh, however often it happened.
  // `user.id` stays stable (by value) across any number of refreshes
  // for the same signed-in user, so this now only re-runs on a genuine
  // sign-in or sign-out, exactly as intended. See AuthContext.tsx for
  // the full explanation of why `session` itself should never be used
  // as a dependency.
  const userId = session?.user?.id ?? null;

  useFocusEffect(
    useCallback(() => {
      if (!session) {
        setLoading(false);
        setCollections([]);
        return;
      }

      // Refocusing (e.g. backing out of a collection you just opened)
      // doesn't need a real refetch if nothing has changed since the
      // last one — see utils/collectionsCache.ts's getCachedHomeCollections
      // for why this is safe with no time limit, AND why it has to be a
      // module-level cache rather than a ref: router.replace("/") (used
      // by more than one "go home" button in this app, including the
      // collection screen's Home icon) unmounts and remounts this
      // screen rather than merely refocusing the existing instance, so
      // a ref would silently reset right when it matters most. Pull-to-
      // refresh (onRefresh below) always bypasses this and calls
      // fetchCollections directly, so it's unaffected.
      const cached = getCachedHomeCollections(userId!);
      if (cached) {
        setCollections(cached);
        setLoading(false);
        checkSubscription().then(setSubscriptionStatus);
        return;
      }

      setLoading(true);
      Promise.all([
        fetchCollections(session),
        checkSubscription().then(setSubscriptionStatus),
      ]).finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId]),
  );

  async function fetchCollections(currentSession: Session) {
    try {
      // ── Step 1: owned collections ──
      const { data: listData, error: listError } =
        await supabase.functions.invoke("list-collections", {
          body: { userId: currentSession.user.id },
        });

      if (listError) {
        // supabase.functions.invoke()'s error.message is just a generic
        // wrapper ("Edge Function returned a non-2xx status code") — the
        // actual reason lives in the HTTP response body, accessible via
        // error.context (a real Response object on FunctionsHttpError).
        // Logging this is the only way to see what's actually wrong.
        let detail = listError.message;
        try {
          const body = await (listError as any)?.context?.json?.();
          if (body?.error) detail = body.error;
        } catch {
          try {
            detail = await (listError as any)?.context?.text?.();
          } catch {
            // context wasn't readable either — fall back to the generic message
          }
        }
        console.error("[fetchCollections] list-collections failed:", detail);
        throw new Error(detail);
      }

      const names: string[] = listData?.collections ?? [];
      let ownedCollections: Collection[] = [];

      if (names.length > 0) {
        // Fetch all owned collections in parallel — one call per collection
        const ownedData = await Promise.allSettled(
          names.map(async (name: string): Promise<Collection> => {
            const { data, error } = await supabase.functions.invoke(
              "list-photos",
              {
                body: {
                  userId: currentSession.user.id,
                  collectionName: name,
                  includeUrls: true,
                },
              },
            );
            if (error) throw new Error(error.message);

            const allPhotos = (data?.photos || []).filter(
              (p: any) => p.Key && !p.Key.includes("/thumbs/"),
            );

            const previewUrls: PreviewPhoto[] = allPhotos
              .slice(0, 3)
              .map((p: any) => {
                const url = p.thumbUrl ?? p.url;
                if (!url) return null;
                const key = p.thumbUrl ? deriveThumbKey(p.Key) : p.Key;
                return { url, key };
              })
              .filter(
                (p: PreviewPhoto | null): p is PreviewPhoto => p !== null,
              );

            return {
              name,
              previewUrls,
              photoCount: allPhotos.length,
              ownerId: currentSession.user.id,
              isShared: false,
            };
          }),
        );

        ownedCollections = ownedData
          .filter(
            (r): r is PromiseFulfilledResult<Collection> =>
              r.status === "fulfilled",
          )
          .map((r) => r.value);
      }

      // Show owned collections immediately — don't wait for shared
      setCollections(ownedCollections);
      setLoading(false);

      // ── Step 2: shared collections in parallel ──
      let sharedCollections: Collection[] = [];
      // Only true once this fetch genuinely completes — kept separate from
      // "sharedCollections is empty" so a network hiccup below (caught,
      // swallowed) never gets mistaken for "every shared collection was
      // just revoked" by the eviction diff further down.
      let sharedFetchSucceeded = false;
      try {
        const userEmail = currentSession.user.email ?? "";
        const shared = await getSharedCollections(userEmail);

        if (shared.length > 0) {
          const sharedData = await Promise.allSettled(
            shared.map(
              async ({
                ownerId,
                ownerEmail,
                collectionName,
              }): Promise<Collection> => {
                const { data, error } = await supabase.functions.invoke(
                  "list-photos",
                  {
                    body: {
                      userId: ownerId,
                      collectionName,
                      includeUrls: true,
                    },
                  },
                );
                if (error) throw new Error(error.message);

                const allPhotos = (data?.photos || []).filter(
                  (p: any) => p.Key && !p.Key.includes("/thumbs/"),
                );

                // Auto-clean empty shared collections
                if (allPhotos.length === 0) {
                  await supabase
                    .from("shared_collections")
                    .delete()
                    .eq("owner_id", ownerId)
                    .eq("collection_name", collectionName);
                  throw new Error("empty");
                }

                const previewUrls: PreviewPhoto[] = allPhotos
                  .slice(0, 3)
                  .map((p: any) => {
                    const url = p.thumbUrl ?? p.url;
                    if (!url) return null;
                    const key = p.thumbUrl ? deriveThumbKey(p.Key) : p.Key;
                    return { url, key };
                  })
                  .filter(
                    (p: PreviewPhoto | null): p is PreviewPhoto => p !== null,
                  );

                return {
                  name: collectionName,
                  previewUrls,
                  photoCount: allPhotos.length,
                  ownerId,
                  ownerEmail,
                  isShared: true,
                };
              },
            ),
          );

          sharedCollections = sharedData
            .filter(
              (r): r is PromiseFulfilledResult<Collection> =>
                r.status === "fulfilled",
            )
            .map((r) => r.value);
        }
        sharedFetchSucceeded = true;
      } catch {
        // Shared collections failing never blocks owned ones.
      }

      // ── Evict cache for shared collections that just disappeared ──
      // Compares against what was shared last time this screen loaded —
      // anything missing now was either unshared by the owner or deleted
      // outright. This is necessarily a partial cleanup: it only knows
      // about the handful of preview thumbnails shown on THIS screen, not
      // every photo the user may have viewed inside the full collection
      // view (that's handled separately — see the list-photos 403 handler
      // in app/collection/[id].tsx, which has the complete photo list for
      // whichever collection was actually open). Between the two, the
      // collections someone is most likely to have fully cached (ones
      // they actually opened) are covered; a collection only ever seen
      // as a home-screen preview is limited to those 1-3 thumbnails
      // anyway, so there's nothing more to evict for it.
      if (sharedFetchSucceeded) {
        const currentIds = new Set(
          sharedCollections.map((c) => `${c.ownerId}::${c.name}`),
        );
        const revoked = getPreviousSharedCollections().filter(
          (c) => !currentIds.has(`${c.ownerId}::${c.name}`),
        );
        if (revoked.length > 0) {
          const keysToEvict = revoked.flatMap((c) =>
            c.previewUrls.map((p) => p.key),
          );
          evictPhotosFromCache(keysToEvict).catch(() => {});
        }
        setPreviousSharedCollections(sharedCollections);
      }

      // Append shared collections once loaded
      const finalCollections = [...ownedCollections, ...sharedCollections];
      setCollections(finalCollections);

      // Mark this fetch fresh — see the comment on getCachedHomeCollections
      // in utils/collectionsCache.ts.
      setCachedHomeCollections(currentSession.user.id, finalCollections);
    } catch (error: any) {
      console.error("fetchCollections error:", error.message);
      showAlert(
        "Error",
        "Could not load your collections. Please try again.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    if (session) fetchCollections(session);
  }, [session]);

  function confirmDeleteCollection(collection: Collection) {
    showAlert(
      "Delete Collection",
      `Are you sure you want to delete "${collection.name}" and all its photos?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            if (!session) return;
            try {
              await deleteCollection(session.user.id, collection.name);
              // Drops this collection's cached photos in
              // app/collection/[id].tsx too (not just bumping the home
              // screen's own counter) — otherwise a stray navigation back
              // to its URL (browser back/forward, a bookmark) could
              // hydrate stale cached photos for a collection that no
              // longer exists, with no server round-trip to catch it.
              // dropCollectionCache also bumps the home counter as a
              // side effect, so this covers both.
              dropCollectionCache(session.user.id, collection.name);
              await fetchCollections(session);
            } catch (error: any) {
              console.error("Delete collection error:", error.message);
              showAlert("Error", "Something went wrong. Please try again.");
            }
          },
        },
      ],
    );
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  const [showProfileMenu, setShowProfileMenu] = useState(false);

  const leftCollections = collections.filter((_, i) => i % 2 === 0);
  const rightCollections = collections.filter((_, i) => i % 2 !== 0);

  const renderCard = (
    collection: Collection,
    index: number,
    heightRatios: number[],
  ) => {
    const cardHeight = COLUMN_WIDTH * heightRatios[index % heightRatios.length];
    return (
      <TouchableOpacity
        key={`${collection.ownerId}-${collection.name}`}
        style={[styles.collectionCard, { height: cardHeight }]}
        onPress={() =>
          router.push(
            `/collection/${encodeURIComponent(collection.name)}?ownerId=${collection.ownerId}`,
          )
        }
        onLongPress={() =>
          !collection.isShared && confirmDeleteCollection(collection)
        }
        activeOpacity={0.85}
      >
        <CollectionCollage
          photos={collection.previewUrls}
          name={collection.name}
        />

        {collection.isShared && (
          <View style={styles.sharedBadge}>
            <Text style={styles.sharedBadgeText}>Shared with you</Text>
          </View>
        )}

        {!collection.isShared && (
          <TouchableOpacity
            style={styles.deleteCardButton}
            onPress={(e) => {
              e.stopPropagation();
              confirmDeleteCollection(collection);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.deleteCardButtonText}>✕</Text>
          </TouchableOpacity>
        )}

        <View style={styles.collectionMeta}>
          <Text style={styles.photoCount}>
            {collection.photoCount} photo
            {collection.photoCount !== 1 ? "s" : ""}
            {collection.isShared ? ` · ${collection.ownerEmail}` : ""}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: Platform.OS === "web" ? 16 : insets.top + 6 },
        ]}
      >
        {/* Left */}
        <View style={styles.headerLeft}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => router.replace("/")}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="home-outline" size={22} color="#111" />
          </TouchableOpacity>

          {/* Tier badge — shows immediately with "..." while loading */}
          <TouchableOpacity
            style={[
              styles.tierButton,
              subscriptionStatus?.isActive && {
                borderColor: "#4AE8A0",
                backgroundColor: "rgba(74,232,160,0.08)",
              },
            ]}
            onPress={() => router.push("/subscription")}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={subscriptionStatus?.isActive ? "star" : "star-outline"}
              size={14}
              color={subscriptionStatus?.isActive ? "#4AE8A0" : "#888"}
            />
            <Text
              style={[
                styles.tierLabel,
                subscriptionStatus?.isActive && { color: "#4AE8A0" },
              ]}
            >
              {subscriptionStatus === null
                ? "..."
                : subscriptionStatus.isActive
                  ? (subscriptionStatus.limits?.label ?? "Pro")
                  : "Free"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Center logo */}
        <TouchableOpacity
          style={styles.headerCenter}
          onPress={() => router.replace("/")}
        >
          <RNImage
            source={require("@/assets/images/icon.png")}
            style={styles.headerLogo}
            resizeMode="contain"
          />
        </TouchableOpacity>

        {/* Right */}
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => router.push("/new-collection")}
          >
            <Ionicons name="add-circle-outline" size={24} color="#111" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => setShowProfileMenu(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="person-circle-outline" size={24} color="#111" />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Profile dropdown menu ── */}
      {showProfileMenu && (
        <>
          <TouchableOpacity
            style={styles.profileMenuBackdrop}
            activeOpacity={1}
            onPress={() => setShowProfileMenu(false)}
          />
          <View
            style={[
              styles.profileMenu,
              { top: Platform.OS === "web" ? 64 : insets.top + 62 },
            ]}
          >
            <TouchableOpacity
              style={styles.profileMenuItem}
              onPress={() => {
                setShowProfileMenu(false);
                router.push("/about");
              }}
            >
              <Ionicons
                name="information-circle-outline"
                size={18}
                color="#333"
              />
              <Text style={styles.profileMenuItemText}>About Mems</Text>
            </TouchableOpacity>

            <View style={styles.profileMenuDivider} />

            <TouchableOpacity
              style={styles.profileMenuItem}
              onPress={() => {
                setShowProfileMenu(false);
                router.push("/account-management");
              }}
            >
              <Ionicons name="settings-outline" size={18} color="#333" />
              <Text style={styles.profileMenuItemText}>Account Management</Text>
            </TouchableOpacity>

            <View style={styles.profileMenuDivider} />

            <TouchableOpacity
              style={styles.profileMenuItem}
              onPress={() => {
                setShowProfileMenu(false);
                signOut();
              }}
            >
              <Ionicons name="log-out-outline" size={18} color="#333" />
              <Text style={styles.profileMenuItemText}>Sign out</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Collections Grid */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#000" />
        </View>
      ) : collections.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>🗂️</Text>
          <Text style={styles.emptyTitle}>No collections yet</Text>
          <Text style={styles.emptyText}>
            Tap + to create your first collection
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.grid}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          <View style={styles.columns}>
            <View style={styles.column}>
              {leftCollections.map((c, i) => renderCard(c, i, LEFT_HEIGHTS))}
            </View>
            <View style={styles.column}>
              {rightCollections.map((c, i) => renderCard(c, i, RIGHT_HEIGHTS))}
            </View>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f5f5f5" },

  // ── Header ────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 12,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    minHeight: Platform.OS === "web" ? 64 : 56,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  headerCenter: { alignItems: "center", justifyContent: "center" },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flex: 1,
    justifyContent: "flex-end",
  },

  // ── Profile dropdown menu ─────────────────────────────────
  profileMenuBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 998,
  },
  profileMenu: {
    position: "absolute",
    right: 16,
    backgroundColor: "#fff",
    borderRadius: 14,
    paddingVertical: 6,
    minWidth: 200,
    zIndex: 999,
    borderWidth: 1,
    borderColor: "#eee",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.15,
        shadowRadius: 16,
      },
      android: { elevation: 12 },
      web: { boxShadow: "0 8px 28px rgba(0,0,0,0.15)" } as any,
    }),
  },
  profileMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  profileMenuItemText: {
    fontSize: 14,
    color: "#333",
    fontWeight: "500",
  },
  profileMenuItemDanger: {
    color: "rgba(220,40,40,0.9)",
  },
  profileMenuDivider: {
    height: 1,
    backgroundColor: "#f0f0f0",
    marginVertical: 2,
  },
  headerLogo: {
    height: Platform.OS === "web" ? 40 : SCREEN_WIDTH * 0.12,
    width: Platform.OS === "web" ? 40 : SCREEN_WIDTH * 0.12,
    resizeMode: "contain",
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },

  // ── Tier badge ────────────────────────────────────────────
  tierButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "#f5f5f5",
    borderWidth: 1,
    borderColor: "#eee",
  },
  tierLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#888",
    letterSpacing: 0.2,
  },

  // ── Grid ─────────────────────────────────────────────────
  grid: { padding: 16, paddingBottom: 36 },
  columns: { flexDirection: "row", gap: 16 },
  column: { flex: 1, gap: 16 },

  // ── Collection card ───────────────────────────────────────
  collectionCard: {
    width: "100%",
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e0e0e0",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 5,
  },
  collectionMeta: { position: "absolute", bottom: 0, left: 0, right: 0 },
  photoCount: {
    fontSize: 11,
    color: "rgba(255,255,255,0.8)",
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  deleteCardButton: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  deleteCardButtonText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 14,
  },

  // ── Collage ───────────────────────────────────────────────
  collageContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: 3,
  },
  collageLeft: { flex: 1.1, position: "relative" },
  collageRight: { flex: 0.9, gap: 3 },
  collageRightTop: { flex: 1.2, position: "relative" },
  collageRightBottom: { flex: 0.8, position: "relative" },
  collageOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 8,
    paddingVertical: 20,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  collageName: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 13,
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  sharedBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    backgroundColor: "rgba(0,100,255,0.75)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    zIndex: 10,
  },
  sharedBadgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },

  // ── Empty / loading ───────────────────────────────────────
  centered: { flex: 1, justifyContent: "center", alignItems: "center", gap: 8 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 18, fontWeight: "600", color: "#333" },
  emptyText: { fontSize: 14, color: "#999" },

  // Legacy styles kept for safety
  subtitle: {
    fontSize: Math.min(12, SCREEN_WIDTH * 0.031),
    color: "#999",
    marginTop: 2,
  },
  subscriptionBadge: {
    fontSize: 10,
    color: "#4AE8A0",
    fontWeight: "600",
    marginTop: 2,
  },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  newButton: {
    backgroundColor: "#111",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  newButtonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: Math.min(13, SCREEN_WIDTH * 0.034),
  },
  signOutButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#ddd",
  },
  signOutText: { fontSize: Math.min(13, SCREEN_WIDTH * 0.034), color: "#666" },
  collageEmpty: { flex: 1, backgroundColor: "#e8e8e8" },
});
