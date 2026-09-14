import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  FlatList,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AlbumBackground from "../../components/AlbumBackground";
import {
  INERT_FLIP_ANIM,
  PhotoFlipCard,
  VIEWER_BOTTOM_CHROME,
  VIEWER_TOP_CHROME,
  type Photo,
} from "../../components/PhotoFlipCard";
import { getSharedPhotos, type SharedPhoto } from "../../utils/sharedPhotos";

const SCREEN_WIDTH = Dimensions.get("window").width;
const SCREEN_HEIGHT = Dimensions.get("window").height;
const IS_DESKTOP_WEB = Platform.OS === "web" && SCREEN_WIDTH >= 768;

// Pagination dots — same stride/window constants as collection/[id].tsx's
// own viewer (deliberately duplicated rather than imported: they're pure
// numbers with no shared behavior, and keeping this screen's copy local
// avoids the two viewers' dot-strip sizing becoming accidentally coupled
// through a module that has nothing else to do with sharing).
const DOT_STRIDE = 15;
const DOTS_VISIBLE = 5;
const DOTS_WINDOW_WIDTH = DOTS_VISIBLE * DOT_STRIDE;

// A GROUP of individually-shared photos, all from the same
// (ownerId, collectionName) pair — the recipient's home screen now shows
// one card per group rather than one per photo (see app/index.tsx's
// sharedPhotoGroups), and tapping it lands here. This screen re-derives
// its own list of exactly which photos it's allowed to show by calling
// getSharedPhotos() fresh and filtering to this group, rather than
// trusting a list of keys passed as nav params — consistent with this
// app's "don't trust client-side access assumptions" approach elsewhere
// (see generate-read-url's own fresh shared_photos check). A share the
// owner has since revoked, or a photo/collection they've deleted, simply
// won't be in that fresh list — no separate "handle a stale param"
// branch needed.
//
// Deliberately NOT a browsable window into the full collection: only
// photos individually shared with this recipient appear here, exactly
// the same scoping guarantee the single-photo screen this replaced had.
// Paging/flip UX is intentionally identical to collection/[id].tsx's own
// full-screen viewer (same PhotoFlipCard, same dot strip, same swipe
// mechanics) — isOwner is always false here, so caption editing and the
// delete/share-photo controls never appear, but everything else about
// how a photo, its flip, and its caption behave is the same component.
export default function SharedPhotoGroupScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    key?: string;
    collectionName?: string;
  }>();

  // Route params can arrive as string | string[] depending on how expo-
  // router parsed the URL — normalise to a single string up front so
  // nothing downstream has to think about the array case.
  const rawOwnerId = Array.isArray(params.key) ? params.key[0] : params.key;
  const collectionName = Array.isArray(params.collectionName)
    ? params.collectionName[0]
    : params.collectionName;

  const ownerId = rawOwnerId ? decodeURIComponent(rawOwnerId) : null;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(
    null,
  );
  const dotsScrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!ownerId || !collectionName) {
      setError("This link is missing an album.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSharedPhotos()
      .then((all: SharedPhoto[]) => {
        if (cancelled) return;
        const group = all.filter(
          (p) => p.ownerId === ownerId && p.collectionName === collectionName,
        );
        const mapped: Photo[] = group
          .filter((p) => p.url)
          .map((p) => ({
            key: p.photoKey,
            url: p.url as string,
            thumbUrl: p.thumbUrl ?? undefined,
            width: p.metadata.width,
            height: p.metadata.height,
            caption: p.caption ?? undefined,
          }));
        setPhotos(mapped);
        // Always open on the first photo in the group, regardless of
        // which one is shown as the cover thumbnail on the home screen —
        // swiping from there moves forward through the rest of the group.
        setSelectedPhotoIndex(mapped.length > 0 ? 0 : null);
        if (mapped.length === 0) {
          setError("These photos are no longer available.");
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setError(err.message || "These photos are no longer available.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, collectionName]);

  // ── Flip state — mirrors collection/[id].tsx exactly ──────────────
  const [isFlipped, setIsFlipped] = useState(false);
  const flipAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    setIsFlipped(false);
    flipAnim.setValue(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPhotoIndex]);

  function toggleFlip() {
    const flippingToBack = !isFlipped;
    Animated.timing(flipAnim, {
      toValue: flippingToBack ? 180 : 0,
      duration: 450,
      useNativeDriver: true,
    }).start();
    setIsFlipped(flippingToBack);
  }

  // Re-centers the active dot every time the selected photo changes.
  useEffect(() => {
    if (selectedPhotoIndex === null) return;
    const x = selectedPhotoIndex * DOT_STRIDE + DOT_STRIDE / 2;
    dotsScrollRef.current?.scrollTo({ x, animated: true });
  }, [selectedPhotoIndex]);

  // ── Web drag-to-swipe — mirrors collection/[id].tsx exactly ────────
  const swipeX = useRef(new Animated.Value(0)).current;

  function goToNext() {
    setSelectedPhotoIndex((prev) => {
      if (prev === null || prev >= photos.length - 1) return prev;
      swipeX.setValue(0);
      return prev + 1;
    });
  }
  function goToPrev() {
    setSelectedPhotoIndex((prev) => {
      if (prev === null || prev <= 0) return prev;
      swipeX.setValue(0);
      return prev - 1;
    });
  }
  const goToNextRef = useRef(goToNext);
  const goToPrevRef = useRef(goToPrev);
  goToNextRef.current = goToNext;
  goToPrevRef.current = goToPrev;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 10,
      onPanResponderMove: (_, gs) => {
        swipeX.setValue(gs.dx);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dx < -80) goToNextRef.current();
        else if (gs.dx > 80) goToPrevRef.current();
        Animated.spring(swipeX, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  function close() {
    router.canGoBack() ? router.back() : router.replace("/");
  }

  return (
    <AlbumBackground style={styles.container}>
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#111" />
        </View>
      ) : error || photos.length === 0 || selectedPhotoIndex === null ? (
        <View style={styles.centered}>
          <View style={styles.errorBox}>
            <Text style={styles.errorIcon}>📷</Text>
            <Text style={styles.errorText}>
              {error || "These photos are no longer available."}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.errorCloseButton}
            onPress={close}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close" size={20} color="#111" />
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Native — FlatList with paging, identical mechanics to
              collection/[id].tsx's own viewer. */}
          {Platform.OS !== "web" && (
            <FlatList
              data={photos}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              initialScrollIndex={selectedPhotoIndex}
              keyExtractor={(item) => item.key}
              getItemLayout={(_, index) => ({
                length: SCREEN_WIDTH,
                offset: SCREEN_WIDTH * index,
                index,
              })}
              onMomentumScrollEnd={(e) => {
                const newIndex = Math.round(
                  e.nativeEvent.contentOffset.x / SCREEN_WIDTH,
                );
                setSelectedPhotoIndex(newIndex);
              }}
              renderItem={({ item, index }) => {
                // Every page renders the SAME component, active or not —
                // same white-flash-avoidance reasoning as
                // collection/[id].tsx (see INERT_FLIP_ANIM's own
                // comment). isOwner is always false here — recipients
                // never get caption editing or delete/share controls.
                const active = index === selectedPhotoIndex;
                return (
                  <AlbumBackground style={styles.fullScreenPage}>
                    <PhotoFlipCard
                      item={item}
                      isOwner={false}
                      isFlipped={active && isFlipped}
                      flipAnim={active ? flipAnim : INERT_FLIP_ANIM}
                      onTapCaption={() => {}}
                      onFlip={active ? () => toggleFlip() : () => {}}
                    />
                  </AlbumBackground>
                );
              }}
              windowSize={5}
              maxToRenderPerBatch={3}
              initialNumToRender={3}
            />
          )}

          {/* Web (including mobile web) — drag-to-swipe, identical
              mechanics to collection/[id].tsx's own viewer. */}
          {Platform.OS === "web" && (
            <View style={styles.webViewerWrapper}>
              <Animated.View
                style={[
                  StyleSheet.absoluteFill,
                  styles.webImageDragLayer,
                  { transform: [{ translateX: swipeX }] },
                ]}
                {...panResponder.panHandlers}
              >
                <PhotoFlipCard
                  item={photos[selectedPhotoIndex]}
                  isOwner={false}
                  isFlipped={isFlipped}
                  flipAnim={flipAnim}
                  onTapCaption={() => {}}
                  onFlip={() => toggleFlip()}
                />
              </Animated.View>
            </View>
          )}

          {/* Controls overlay — rendered last so always on top */}
          <View style={styles.viewerControls} pointerEvents="box-none">
            <TouchableOpacity
              style={styles.fullScreenClose}
              onPress={close}
              hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
            >
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>

            {/* pointerEvents="none" — this is a purely informational label,
                but as an absolutely-positioned View spanning left:0/right:0
                (full screen width) it would otherwise still capture taps
                landing anywhere in its full-width row, including on top of
                fullScreenClose just below/beside it — exactly what made
                close untappable while flip (rendered after this, so higher
                in paint order) stayed clickable. Without pointerEvents,
                only the visible Text glyphs would seem interactive, but
                the invisible rest of the row still intercepts touches by
                default. */}
            <View style={styles.fullScreenCounter} pointerEvents="none">
              <Text style={styles.fullScreenCounterText}>
                {selectedPhotoIndex + 1} / {photos.length}
              </Text>
            </View>

            <TouchableOpacity
              style={styles.fullScreenFlip}
              onPress={() => toggleFlip()}
              hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
            >
              <Ionicons name="reload-outline" size={22} color="#fff" />
            </TouchableOpacity>

            {photos.length > 1 && (
              <ScrollView
                ref={dotsScrollRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.pageDots}
                contentContainerStyle={styles.pageDotsContent}
              >
                {photos.map((photo, i) => (
                  <View
                    key={photo.key}
                    style={
                      i === selectedPhotoIndex
                        ? styles.pageDotActive
                        : styles.pageDot
                    }
                  />
                ))}
              </ScrollView>
            )}
          </View>
        </>
      )}
    </AlbumBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 20,
  },
  errorBox: { alignItems: "center", gap: 10 },
  errorIcon: { fontSize: 40 },
  errorText: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    maxWidth: 260,
  },
  errorCloseButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.6)",
  },
  viewerControls: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    pointerEvents: "box-none" as any,
  },
  fullScreenClose: {
    position: "absolute",
    top: Platform.OS === "web" ? 20 : 52,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  fullScreenFlip: {
    position: "absolute",
    top: Platform.OS === "web" ? 20 : 52,
    right: 76,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  fullScreenCounter: {
    position: "absolute",
    top: Platform.OS === "web" ? 26 : 58,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  fullScreenCounterText: {
    color: "rgba(0,0,0,0.55)",
    fontSize: 14,
    fontWeight: "600",
  },
  fullScreenPage: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: VIEWER_TOP_CHROME,
    paddingBottom: VIEWER_BOTTOM_CHROME,
  },
  webViewerWrapper: {
    flex: 1,
    width: "100%",
    height: SCREEN_HEIGHT,
    position: "relative",
    overflow: "hidden",
  },
  webImageDragLayer: {
    justifyContent: "center",
    alignItems: "center",
    paddingTop: IS_DESKTOP_WEB ? 0 : VIEWER_TOP_CHROME,
    paddingBottom: IS_DESKTOP_WEB ? 0 : VIEWER_BOTTOM_CHROME,
    ...Platform.select({ web: { touchAction: "pan-y" } as any, default: {} }),
  },
  pageDots: {
    position: "absolute",
    bottom: 10,
    left: (SCREEN_WIDTH - DOTS_WINDOW_WIDTH) / 2,
    width: DOTS_WINDOW_WIDTH,
    height: 18,
    zIndex: 10,
  },
  pageDotsContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: DOTS_WINDOW_WIDTH / 2,
  },
  pageDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "rgba(0,0,0,0.28)",
  },
  pageDotActive: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: "rgba(0,0,0,0.7)",
  },
});
