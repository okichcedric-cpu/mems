import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { markOnboardingSeen } from "../utils/onboarding";

// ── First-time walkthrough ────────────────────────────────────────────
// Shown exactly once per device, right after a user's first sign-in (see
// the routing effect in app/_layout.tsx) — a handful of full-screen cards
// explaining the app's core concepts, rather than a coach-mark library
// pointing at specific buttons. Custom-built instead of pulling in a
// dedicated intro-slider package: the well-known ones
// (react-native-app-intro-slider) are years stale, and this is a plain
// horizontally-paged ScrollView, which is little more code than wiring up
// a library while matching the app's own look.
//
// Each slide's media is a short looping GIF of the REAL app in action —
// recorded against a live test account via browser automation, then
// re-encoded (ffmpeg, lanczos upscale + palettegen/paletteuse with
// sierra2_4a error-diffusion dithering — a noticeably cleaner look than
// the ordered/bayer dithering used in the first pass, which read as
// blocky once stretched) at 850px wide, ~590KB-2.1MB each (~5.8MB
// total) — bigger than the original 700px/~3MB pass, but the previous
// size was tuned for a much smaller inset card, not today's full-bleed
// treatment. Each GIF's height matches its slide.aspectRatio exactly
// (see SLIDES below), so contentFit="cover" never actually needs to
// crop anything — full-bleed fill, not a lossy crop. expo-image's
// <Image> plays animated GIFs natively on both native and web, so no
// video player/library is needed just to loop these.
//
// Layout has two distinct presentations, decided at render time from
// useWindowDimensions (not a one-off Dimensions.get() snapshot, so
// resizing a desktop browser window actually re-lays this out):
//   - Phone-width web and native app: the "frame" (media + text + dots)
//     fills the entire screen edge-to-edge — a full-bleed mobile
//     onboarding screen.
//   - Desktop web (wide browser window): filling the whole browser
//     window edge-to-edge looked broken (a giant stretched/cropped GIF
//     with no sense of scale) — instead the frame becomes a fixed-size,
//     rounded, shadowed card centred on a soft neutral backdrop, closer
//     to how a marketing site would present an app-store screenshot.

type Slide = {
  gif: number;
  // Real aspect ratio of the source recording (all re-encoded at 1000px
  // wide — see assets/images/onboarding/README-encode.txt). Used on
  // mobile to size the top banner so its height falls out of the width
  // instead of an arbitrary guess: matching the source aspect exactly
  // means contentFit="cover" never actually has to crop anything, so
  // nothing is lost off the sides of a real recorded screen.
  aspectRatio: number;
  title: string;
  body: string;
};

const SLIDES: Slide[] = [
  {
    gif: require("@/assets/images/onboarding/onboarding-browse-home-v2.gif"),
    aspectRatio: 1000 / 576,
    title: "Welcome to Mems",
    body: "Your memories, organised into beautiful collections you can revisit any time.",
  },
  {
    gif: require("@/assets/images/onboarding/onboarding-create-collection-v2.gif"),
    aspectRatio: 1000 / 531,
    title: "Create a collection",
    body: "Group photos from a trip, birthday, or any moment worth keeping. Give it a name, and if you like, the date it happened",
  },
  {
    gif: require("@/assets/images/onboarding/onboarding-share-collection-v2.gif"),
    aspectRatio: 1000 / 531,
    title: "Share with who matters",
    body: "Invite family and friends by email so they can enjoy the same collection right alongside you.",
  },
  {
    gif: require("@/assets/images/onboarding/onboarding-open-collection-v2.gif"),
    aspectRatio: 1000 / 576,
    title: "Open a collection",
    body: "Tap into any collection to see every photo laid out like a page from a real photo album.",
  },
  {
    gif: require("@/assets/images/onboarding/onboarding-view-photo-v2.gif"),
    aspectRatio: 1000 / 576,
    title: "Flip through like a real album",
    body: "Tap any photo to view it full-screen, then swipe to move through the whole collection.",
  },
];

// Card size on desktop web — a fixed, phone-app-like aspect rather than
// stretching to the browser's full width/height.
const DESKTOP_CARD_WIDTH = 900;
const DESKTOP_CARD_HEIGHT = 560;
const DESKTOP_CARD_MARGIN = 40;

export default function Onboarding() {
  const router = useRouter();
  const scrollRef = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);
  const isLast = index === SLIDES.length - 1;

  // useWindowDimensions (not a one-off Dimensions.get() call) so resizing
  // a desktop browser window between mobile- and desktop-width actually
  // re-triggers this layout instead of freezing whatever size the page
  // happened to load at.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isDesktopWeb = Platform.OS === "web" && windowWidth >= 768;

  // The frame is the single source of truth for slide width: full window
  // width on phones/native, a capped card on desktop web. Everything else
  // (media width, paging math) derives from it.
  const frameWidth = isDesktopWeb
    ? Math.min(DESKTOP_CARD_WIDTH, windowWidth - DESKTOP_CARD_MARGIN * 2)
    : windowWidth;
  const frameHeight = isDesktopWeb
    ? Math.min(DESKTOP_CARD_HEIGHT, windowHeight - DESKTOP_CARD_MARGIN * 2)
    : undefined;
  // Desktop keeps the side-by-side split (GIF left half / text right
  // half). On mobile the GIF becomes a full-width banner across the top
  // of the screen with the text below it — a row doesn't read well once
  // "half the screen" means "half of a narrow phone width" rather than
  // half of a wide card.
  const mediaWidth = isDesktopWeb ? frameWidth / 2 : frameWidth;

  async function finish() {
    await markOnboardingSeen();
    router.replace("/");
  }

  function goNext() {
    if (isLast) {
      finish();
      return;
    }
    const nextIndex = index + 1;
    scrollRef.current?.scrollTo({ x: nextIndex * frameWidth, animated: true });
    setIndex(nextIndex);
  }

  function onMomentumScrollEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const i = Math.round(e.nativeEvent.contentOffset.x / frameWidth);
    setIndex(Math.max(0, Math.min(SLIDES.length - 1, i)));
  }

  // Shared between the two footer placements below: a floating overlay
  // pinned to the bottom of the desktop card, or — on mobile, per the
  // request that the button sit directly under the text with no dead
  // space — plain in-flow content immediately after each slide's text.
  function renderControls() {
    return (
      <>
        <View style={styles.dots}>
          {SLIDES.map((slide, i) => (
            <View
              key={slide.title}
              style={i === index ? styles.dotActive : styles.dot}
            />
          ))}
        </View>

        <TouchableOpacity style={styles.primaryButton} onPress={goNext}>
          <Text style={styles.primaryButtonText}>
            {isLast ? "Get started" : "Next"}
          </Text>
        </TouchableOpacity>
      </>
    );
  }

  return (
    <View
      style={[
        styles.container,
        isDesktopWeb ? styles.containerDesktop : styles.containerMobile,
      ]}
    >
      <View
        style={[
          styles.frame,
          isDesktopWeb
            ? {
                width: frameWidth,
                height: frameHeight,
                borderRadius: 28,
              }
            : { flex: 1, width: frameWidth },
        ]}
      >
        {/* Absolutely fills the frame — full screen on mobile/native, the
            card's bounds on desktop web — so the slide (and its GIF) runs
            edge-to-edge within whichever container this is. */}
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onMomentumScrollEnd}
          style={styles.scrollView}
        >
          {SLIDES.map((slide) => (
            <View
              key={slide.title}
              style={[
                styles.slide,
                isDesktopWeb
                  ? { width: frameWidth, flexDirection: "row" }
                  : {
                      width: frameWidth,
                      flexDirection: "column",
                      justifyContent: "center",
                    },
              ]}
            >
              <View
                style={[
                  styles.mediaFrame,
                  isDesktopWeb
                    ? {
                        width: mediaWidth,
                        alignItems: "center",
                        justifyContent: "center",
                      }
                    : {
                        width: mediaWidth,
                        height: mediaWidth / slide.aspectRatio,
                      },
                ]}
              >
                <Image
                  source={slide.gif}
                  style={
                    isDesktopWeb
                      ? { width: mediaWidth, aspectRatio: slide.aspectRatio }
                      : styles.mediaGif
                  }
                  contentFit={isDesktopWeb ? "contain" : "cover"}
                  autoplay
                />
              </View>
              <View
                style={[
                  styles.textCol,
                  isDesktopWeb
                    ? { width: "50%" }
                    : { width: "100%", alignItems: "center", marginTop: 28 },
                ]}
              >
                <Text
                  style={[styles.title, !isDesktopWeb && styles.textCenter]}
                >
                  {slide.title}
                </Text>
                <Text style={[styles.body, !isDesktopWeb && styles.textCenter]}>
                  {slide.body}
                </Text>
              </View>

              {/* Mobile: dots + button sit right here, directly under the
                  text, as plain in-flow content — no gap to the bottom of
                  the screen. Desktop keeps them in the floating footer
                  below instead (see !isDesktopWeb guard there). */}
              {!isDesktopWeb && (
                <View style={styles.controlsInline}>{renderControls()}</View>
              )}
            </View>
          ))}
        </ScrollView>

        {!isLast && (
          <TouchableOpacity
            style={styles.skipButton}
            onPress={finish}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>
        )}

        {isDesktopWeb && <View style={styles.footer}>{renderControls()}</View>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Mobile web + native: the frame below fills this completely, so the
  // container's own background is never actually visible.
  containerMobile: { backgroundColor: "#fff" },
  // Desktop web: a soft neutral backdrop that stays visible around the
  // centred card, instead of either stark white void or the card
  // stretching to fill the whole browser window.
  containerDesktop: {
    backgroundColor: "#eeeae0",
    alignItems: "center",
    justifyContent: "center",
  },
  // Base frame — sizing (full screen vs. fixed card) is applied inline
  // per-platform above; this just holds the shared visual treatment.
  frame: {
    position: "relative",
    overflow: "hidden",
    backgroundColor: "#fff",
    ...Platform.select({
      web: {
        // Only matters on the desktop-web card; invisible (and harmless)
        // once the mobile-web frame stretches edge-to-edge.
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
      },
      default: {},
    }),
  },
  skipButton: {
    position: "absolute",
    top: Platform.OS === "web" ? 20 : 56,
    right: 20,
    zIndex: 10,
    padding: 8,
  },
  skipText: { fontSize: 15, color: "#666", fontWeight: "500" },
  // Absolutely fills the frame — full screen on mobile/native, the card's
  // bounds on desktop web.
  scrollView: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  // Desktop: side-by-side, GIF owns the left half edge-to-edge, title/body
  // sit in the right half (flexDirection: "row" applied inline).
  // Mobile/native: stacked, GIF is a full-width banner across the top,
  // text below it (flexDirection: "column" applied inline).
  slide: {
    flex: 1,
    alignItems: "stretch",
  },
  mediaFrame: {
    position: "relative",
    overflow: "hidden",
    backgroundColor: "#f3f0e8",
  },
  // Mobile: the mediaFrame's own height is set (inline, per-slide) to
  // exactly match the GIF's aspect ratio, so an absolute fill + "cover"
  // never actually needs to crop — this is just a reliable way to make
  // an Image fill a box on web (nested percentage widths on a web Image
  // inside a flex row were an earlier bug that left the GIF not actually
  // spanning the full width).
  // Desktop: the mediaFrame is taller than the GIF's own aspect ratio
  // would call for (it stretches to the full card height), so the Image
  // is sized explicitly (width + aspectRatio, contentFit="contain") and
  // centred by the frame instead — shrinking to fit rather than cropping.
  mediaGif: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  textCol: {
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  textCenter: { textAlign: "center" },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#111",
    marginBottom: 12,
  },
  body: {
    fontSize: 15,
    color: "#666",
    lineHeight: 22,
  },
  // Mobile only: dots + button as plain in-flow content directly under
  // the text (see the !isDesktopWeb branch in the slide map) — no
  // floating overlay, no reserved gap, just normal layout so there's
  // never dead space between the text and the button.
  controlsInline: {
    width: "100%",
    alignItems: "center",
    gap: 20,
    marginTop: 28,
    paddingHorizontal: 32,
    paddingBottom: Platform.OS === "web" ? 8 : 24,
  },
  // Desktop only: floats over the bottom of the card instead of sitting
  // below it in normal flow. A soft white backdrop keeps the dots/button
  // legible over whatever part of the GIF ends up underneath.
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(255,255,255,0.92)",
    paddingHorizontal: 32,
    paddingBottom: Platform.OS === "web" ? 32 : 44,
    paddingTop: 20,
    alignItems: "center",
    gap: 20,
  },
  dots: { flexDirection: "row", gap: 8 },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "rgba(0,0,0,0.2)",
  },
  dotActive: {
    width: 20,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#111",
  },
  primaryButton: {
    backgroundColor: "#111",
    borderRadius: 999,
    paddingVertical: 14,
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
  },
  primaryButtonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
