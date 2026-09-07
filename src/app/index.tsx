import ShimmerPlaceholder from "@/components/ShimmerPlaceholder";
import { useAuth } from "@/contexts/AuthContext";
import { Ionicons } from "@expo/vector-icons";
import { Session } from "@supabase/supabase-js";
import { Image } from "expo-image";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
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
import { getCollectionMemoryDate } from "../utils/collections";
import { deriveThumbKey, evictPhotosFromCache } from "../utils/imageCache";
import { getMemoryDateInfo } from "../utils/memoryDate";
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
  // "When did these memories actually happen" — set optionally at creation
  // time (or later) via MemoryDatePicker. Null/undefined means unset, in
  // which case the polaroid caption below just shows the name.
  memoryDate?: string | null;
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
const CollectionCollage = ({ photos }: { photos: PreviewPhoto[] }) => (
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

  // ── Hide-on-scroll header ─────────────────────────────────────
  // Swiping up (deeper into the collections grid) slides the header off
  // the top of the screen so only collections/photos are visible;
  // swiping back down toward the top brings it back. Standard pattern —
  // Instagram, Twitter, etc. all do this.
  //
  // headerHeight starts at a reasonable estimate (matches styles.header's
  // minHeight + its own top/bottom padding) so the very first frame,
  // before onLayout has fired even once, isn't animating against 0 — it's
  // then corrected to the real measured height (which varies with
  // insets.top per device) the moment the header actually lays out.
  const [headerHeight, setHeaderHeight] = useState(
    (Platform.OS === "web" ? 16 : insets.top + 6) +
      (Platform.OS === "web" ? 64 : 56) +
      12,
  );
  const scrollY = useRef(new Animated.Value(0)).current;
  // diffClamp turns raw (unbounded, can go far past headerHeight or
  // negative on overscroll) scroll offset into a value that only ever
  // moves within [0, headerHeight] — and, critically, tracks the
  // DIRECTION of the most recent scroll delta rather than absolute
  // scroll position. That's what makes this "hide when scrolling up,
  // show when scrolling down" instead of "hidden whenever you're not at
  // the very top" — deep in a long scroll, a small downward flick still
  // brings the header back immediately, exactly like the reference apps.
  const clampedScrollY = useMemo(
    () => Animated.diffClamp(scrollY, 0, headerHeight),
    [scrollY, headerHeight],
  );
  const headerTranslateY = clampedScrollY.interpolate({
    inputRange: [0, headerHeight],
    outputRange: [0, -headerHeight],
    extrapolate: "clamp",
  });
  // Content is deliberately NOT using useNativeDriver for this — it needs
  // to reflow (occupy the space the header vacates) as the header slides
  // away, and native-driven transforms can't drive a layout property like
  // marginTop. The header's own translateY above likewise stays off the
  // native driver so both stay perfectly in sync (a native-driven value
  // and a JS-driven one derived from the same scroll events can drift a
  // frame or two apart, which would show as the header and content
  // visibly separating instead of moving as one).
  //
  // NOTE: this is deliberately its own interpolation of clampedScrollY,
  // not derived from headerTranslateY — at rest (clampedScrollY 0) the
  // header sits at its natural position (translateY 0) and content needs
  // a margin of a full headerHeight to start right below it; fully
  // hidden (clampedScrollY === headerHeight) the header has translated
  // -headerHeight off-screen and content needs 0 margin to expand into
  // that space. That's the INVERSE of translateY's own range, not its
  // negation (negating translateY would start content's margin at 0 and
  // grow it while scrolling, which is backwards).
  const contentMarginTop = clampedScrollY.interpolate({
    inputRange: [0, headerHeight],
    outputRange: [headerHeight, 0],
    extrapolate: "clamp",
  });
  const handleScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    { useNativeDriver: false },
  );

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
            // Fetched alongside list-photos, not after it — this is a
            // separate lightweight table read (see utils/collections.ts),
            // so there's no reason to serialize it behind the S3 listing.
            const [{ data, error }, memoryDate] = await Promise.all([
              supabase.functions.invoke("list-photos", {
                body: {
                  userId: currentSession.user.id,
                  collectionName: name,
                  includeUrls: true,
                },
              }),
              getCollectionMemoryDate(currentSession.user.id, name),
            ]);
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
              memoryDate,
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
                const [{ data, error }, memoryDate] = await Promise.all([
                  supabase.functions.invoke("list-photos", {
                    body: {
                      userId: ownerId,
                      collectionName,
                      includeUrls: true,
                    },
                  }),
                  getCollectionMemoryDate(ownerId, collectionName),
                ]);
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
                  memoryDate,
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
    const photoAreaHeight =
      COLUMN_WIDTH * heightRatios[index % heightRatios.length];
    // Only ever set if the user actually picked a date when creating (or
    // later editing) the collection — getMemoryDateInfo returns null for
    // both "never set" (undefined/null) and any unparseable value, so the
    // caption below simply omits the date line rather than showing
    // anything blank or malformed.
    const memoryDateInfo = getMemoryDateInfo(collection.memoryDate);

    return (
      <TouchableOpacity
        key={`${collection.ownerId}-${collection.name}`}
        style={styles.polaroidWrapper}
        onPress={() =>
          router.push(
            `/collection/${encodeURIComponent(collection.name)}?ownerId=${collection.ownerId}`,
          )
        }
        onLongPress={() =>
          !collection.isShared && confirmDeleteCollection(collection)
        }
        activeOpacity={0.9}
      >
        {/* White polaroid card — same border treatment as individual
            photos inside a collection (see collection/[id].tsx's
            polaroidCard), so a collection reads as "a photo of photos"
            rather than a differently-styled UI element. */}
        <View style={styles.polaroidCard}>
          <View style={[styles.photoArea, { height: photoAreaHeight }]}>
            <CollectionCollage photos={collection.previewUrls} />

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
          </View>

          {/* Caption strip — just the name (handwritten) and, only if
              one was actually set, the memory date. No photo count, no
              owner email — this is meant to read like something you'd
              actually write under a printed photo, not a UI data label. */}
          <View style={styles.polaroidCaption}>
            <Text style={styles.collectionNameText} numberOfLines={1}>
              {collection.name}
            </Text>
            {memoryDateInfo && (
              <Text style={styles.collectionDateText} numberOfLines={1}>
                {memoryDateInfo.full}
              </Text>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header — absolutely positioned so it overlays the top of the
          content rather than taking up flex space, which is what lets it
          slide fully off-screen on scroll without leaving a blank gap
          behind it (the content below has its own animated top margin —
          see contentMarginTop — that shrinks in lockstep to fill exactly
          that gap). onLayout keeps headerHeight (and therefore how far it
          has to travel, and how much space content reserves for it) in
          sync with its real measured height instead of the estimate. */}
      <Animated.View
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          if (Math.abs(h - headerHeight) > 0.5) setHeaderHeight(h);
        }}
        style={[
          styles.header,
          styles.headerFloating,
          { paddingTop: Platform.OS === "web" ? 16 : insets.top + 6 },
          { transform: [{ translateY: headerTranslateY }] },
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
      </Animated.View>

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

      {/* Collections Grid — the animated top margin is what actually
          creates the "content expands to fill the space the header just
          vacated" effect; the header sliding away on its own (see above)
          would otherwise just leave a blank gap here. */}
      <Animated.View style={{ flex: 1, marginTop: contentMarginTop }}>
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
            onScroll={handleScroll}
            scrollEventThrottle={16}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
          >
            <View style={styles.columns}>
              <View style={styles.column}>
                {leftCollections.map((c, i) => renderCard(c, i, LEFT_HEIGHTS))}
              </View>
              <View style={styles.column}>
                {rightCollections.map((c, i) =>
                  renderCard(c, i, RIGHT_HEIGHTS),
                )}
              </View>
            </View>
          </ScrollView>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Plain flat background here, deliberately — the aged-paper texture
  // (see AlbumBackground) stays on the collection grid and single-photo
  // viewer, but the landing/home screen keeps its original clean white.
  container: { flex: 1, backgroundColor: "#fff" },

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
  // Layered on top of the content (see the hide-on-scroll comment above
  // the component) instead of taking up its own row in the flex column.
  headerFloating: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
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

  // ── Collection card — styled as a polaroid, matching the individual
  // photo cards inside a collection (see collection/[id].tsx's
  // polaroidWrapper/polaroidCard) so a collection on the home screen reads
  // as "a photo of photos" rather than a differently-styled tile. ──────
  polaroidWrapper: {
    width: "100%",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.16,
        shadowRadius: 8,
      },
      android: { elevation: 5 },
      web: { filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.16))" } as any,
    }),
  },
  polaroidCard: {
    backgroundColor: "#fff",
    padding: 8,
    paddingBottom: 0,
    borderRadius: 2,
  },
  photoArea: {
    position: "relative",
    width: "100%",
    overflow: "hidden",
    backgroundColor: "#e8e8e8",
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
  // ── Caption strip — the white space below the photo, in normal flow
  // (not overlaid on the image), same idea as collection/[id].tsx's
  // polaroidCaption. Holds only the name and, if set, the memory date —
  // no photo count, no owner email.
  polaroidCaption: {
    backgroundColor: "#fff",
    paddingHorizontal: 6,
    paddingTop: 6,
    paddingBottom: 10,
  },
  // Handwritten look via the Caveat font loaded in app/_layout.tsx.
  // Sized up from a normal UI label (13-15px) since script fonts render
  // visually smaller/lighter than sans-serif at the same point size.
  collectionNameText: {
    fontFamily: "Caveat_700Bold",
    color: "#222",
    fontSize: 22,
    lineHeight: 24,
  },
  collectionDateText: {
    fontSize: 11,
    color: "#999",
    marginTop: 1,
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
