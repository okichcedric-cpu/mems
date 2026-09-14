import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import {
  Animated,
  Dimensions,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

// ── The single-photo "polaroid" flip card ─────────────────────────────
// Extracted out of app/collection/[id].tsx so the shared-photo viewer
// (app/shared-photo/[key].tsx — a recipient's scoped view of just the
// photos individually shared with them from one collection) can present
// the exact same flip/caption experience as browsing a full collection,
// rather than a second, hand-rolled approximation of it that would
// inevitably drift out of sync over time. Anywhere this file changes,
// both screens pick it up automatically.
//
// Self-contained: owns its own sizing constants, caption-overflow
// estimate, and styles, all of which used to live inline in
// collection/[id].tsx. Nothing here is specific to viewing an OWNED
// collection — ownership/editability is entirely controlled by the
// `isOwner` prop callers pass in, and `PhotoFlipCard` itself has no
// opinion about where its `item`/`isFlipped`/`flipAnim` come from.

const SCREEN_WIDTH = Dimensions.get("window").width;
const SCREEN_HEIGHT = Dimensions.get("window").height;
const IS_DESKTOP_WEB = Platform.OS === "web" && SCREEN_WIDTH >= 768;

// Shared, never-animated Animated.Value to pass as `flipAnim` for any
// card that ISN'T the currently-active one in a list of these (e.g. the
// FlatList pages either side of the one being viewed) — see
// collection/[id].tsx's original comment (still there) for the full
// story: reusing PhotoFlipCard for every page instead of switching
// between two different component trees is what keeps each page's
// <Image> mounted exactly once, avoiding a white-flash-on-navigate bug.
// Every consumer of PhotoFlipCard that renders more than one at a time
// should reuse this same constant for inactive pages rather than
// creating their own — it's never animated, so one shared instance is
// exactly as correct as many, and cheaper.
export const INERT_FLIP_ANIM = new Animated.Value(0);

export type Photo = {
  key: string;
  url: string;
  thumbUrl?: string;
  width: number;
  height: number;
  // Optional per-photo caption, shown on the "back" of the photo via the
  // flip animation. Undefined (not empty string) means "no caption set".
  caption?: string;
};

// ── Caption "See more…" overflow estimate ─────────────────────
// Must match polaroidCaptionText's own fontSize — used to estimate
// whether a caption will wrap past a single line in the preview strip.
//
// This is deliberately a character-count ESTIMATE rather than an actual
// on-screen measurement (e.g. RN's onTextLayout, or a hidden Text +
// onLayout). Both of those were tried first and both proved unreliable in
// practice: onTextLayout isn't implemented by react-native-web's <Text>
// at all (confirmed by inspecting its source — the callback just never
// fires on web), and the onLayout-based fallback depends on
// ResizeObserver's timing, which is one more moving part than this needs
// for what's ultimately a "does this look like it'll fit" nicety, not
// something that has to be pixel-perfect. A plain average-character-width
// calculation has no browser API dependency at all, so it can't have a
// browser-specific bug — it renders the right answer on the very first
// frame, everywhere, by construction.
const CAPTION_FONT_SIZE = IS_DESKTOP_WEB ? 22 : 19;
// Caveat is a fairly condensed cursive/script font — this ratio (advance
// width as a fraction of font size) was picked by eyeballing rendered
// samples, not measured precisely; being slightly conservative (i.e.
// erring toward showing "See more…" a little early) is the safer
// direction for a truncation cue than the reverse.
const CAPTION_AVG_CHAR_WIDTH = CAPTION_FONT_SIZE * 0.52;
// Rough width of the "See more…" chip itself (label + its own left
// margin) — reserved out of the available width so the ESTIMATE accounts
// for the chip needing to fit on the same line as the truncated caption,
// not just the caption alone.
const CAPTION_SEE_MORE_RESERVED_WIDTH = IS_DESKTOP_WEB ? 84 : 70;

export function estimateCaptionOverflows(
  caption: string,
  availableWidth: number,
): boolean {
  const usableWidth = availableWidth - CAPTION_SEE_MORE_RESERVED_WIDTH;
  if (usableWidth <= 0) return true;
  const maxChars = Math.floor(usableWidth / CAPTION_AVG_CHAR_WIDTH);
  return caption.length > maxChars;
}

// ── Full-screen polaroid frame sizing ─────────────────────────
// The outer box a photo's polaroid card is allowed to occupy — the actual
// card then shrinks to fit its content (see getPolaroidViewerFrame below),
// so these are ceilings, not fixed dimensions.
export const VIEWER_CARD_MAX_WIDTH = IS_DESKTOP_WEB
  ? Math.min(1100, SCREEN_WIDTH * 0.88)
  : SCREEN_WIDTH - 16;
// The card is centered within a safe zone below/above whatever chrome a
// given screen has (a close button, a counter, dots, etc.) — these two
// are that screen's reserved top/bottom space, factored in here so
// VIEWER_CARD_MAX_HEIGHT already accounts for it rather than each screen
// having to separately shrink the card after the fact. Consumers use
// these same two constants for their own page-centering layout (e.g.
// paddingTop/paddingBottom on a centering container) so the reserved
// space is spent once, not doubled.
export const VIEWER_TOP_CHROME = Platform.OS === "web" ? 72 : 104;
export const VIEWER_BOTTOM_CHROME = 28;
export const VIEWER_CARD_MAX_HEIGHT = IS_DESKTOP_WEB
  ? SCREEN_HEIGHT * 0.86
  : Math.min(
      SCREEN_HEIGHT * 0.84,
      SCREEN_HEIGHT - VIEWER_TOP_CHROME - VIEWER_BOTTOM_CHROME,
    );
// A real Polaroid's white border is thin and even on three sides, with a
// noticeably deeper strip along the bottom for the caption.
export const VIEWER_POLAROID_TOP = 10;
export const VIEWER_POLAROID_SIDE = 10;
export const VIEWER_POLAROID_BOTTOM = IS_DESKTOP_WEB ? 56 : 46;

// ── Full-screen polaroid image sizing ────────────────────────
// Sizes the image to the photo's own aspect ratio instead of dropping it
// into a fixed-shape box, so the card's own padding is the only white
// space you see — reads as a deliberate polaroid border rather than
// accidental letterboxing.
export function getPolaroidViewerFrame(item: Photo) {
  const maxImageWidth = VIEWER_CARD_MAX_WIDTH - VIEWER_POLAROID_SIDE * 2;
  const maxImageHeight =
    VIEWER_CARD_MAX_HEIGHT - VIEWER_POLAROID_TOP - VIEWER_POLAROID_BOTTOM;

  const hasDimensions = item.width !== 1 || item.height !== 1;
  const aspectRatio = hasDimensions ? item.height / item.width : 1;

  let width = maxImageWidth;
  let height = width * aspectRatio;
  if (height > maxImageHeight) {
    height = maxImageHeight;
    width = height / aspectRatio;
  }

  return { width, height };
}

// ── Caption preview strip ─────────────────────────────────────
// The polaroid's bottom border — a real Polaroid's is where you'd
// handwrite a line about the photo, so this is where the FRONT of the
// card shows one (the first words, ellipsized if it runs past a single
// line). When there's no caption yet and this card is the flippable,
// owned one, it doubles as the "how do I even add one of these"
// affordance: tapping it flips the card straight to the back AND focuses
// the caption input, rather than requiring someone to already understand
// what the small flip icon up in the corner does.
export function CaptionStrip({
  caption,
  interactive,
  onTap,
  onSeeMore,
  availableWidth,
}: {
  caption?: string;
  interactive: boolean;
  onTap?: () => void;
  onSeeMore?: () => void;
  availableWidth: number;
}) {
  if (caption) {
    // See estimateCaptionOverflows' own comment for why this is a
    // computed estimate rather than an actual on-screen measurement.
    const needsSeeMore = estimateCaptionOverflows(caption, availableWidth);
    const captionText = (
      <Text
        style={styles.polaroidCaptionText}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {caption}
      </Text>
    );
    return (
      <View style={styles.polaroidCaptionStrip}>
        <View style={styles.polaroidCaptionRow}>
          {interactive ? (
            <TouchableOpacity
              onPress={onTap}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={styles.polaroidCaptionTextWrap}
            >
              {captionText}
            </TouchableOpacity>
          ) : (
            <View style={styles.polaroidCaptionTextWrap}>{captionText}</View>
          )}
          {/* Only meaningful on the currently-flippable card — onSeeMore
              is the flip trigger, and non-active cards elsewhere in the
              list have nothing to flip to. Independent of `interactive` —
              a non-owner viewer should still be able to flip to read a
              longer caption, just not edit it. */}
          {needsSeeMore && onSeeMore && (
            <TouchableOpacity
              onPress={onSeeMore}
              hitSlop={{ top: 10, bottom: 10, left: 4, right: 10 }}
            >
              <Text style={styles.polaroidSeeMore}>See more…</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }
  if (interactive) {
    return (
      <View style={styles.polaroidCaptionStrip}>
        <TouchableOpacity
          onPress={onTap}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.polaroidCaptionPrompt}>+ Add a caption</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return <View style={styles.polaroidCaptionStrip} />;
}

// ── Flippable polaroid card ──────────────────────────────────
// This deliberately does NOT use a real 3D rotateY/perspective/
// backfaceVisibility flip — that was tried first and is exactly the kind
// of thing that looks fine in one browser and breaks in the next: it
// showed the front photo mirrored on some engines, and on Opera
// specifically showed BOTH faces overlapping ("hovering" the caption text
// on top of the image) — different failure per engine is the signature of
// relying on real 3D compositing/backface-culling, which browsers
// implement with genuinely inconsistent behavior particularly for two
// independently-3D-transformed sibling elements. Firefox and Safari
// showed no flip animation at all.
//
// Instead, this squashes the card flat via a plain 2D `scaleX` (1 → 0 →
// 1) — a completely ordinary transform with zero cross-browser ambiguity,
// no 3D context, no backface-visibility — and swaps which face is opaque
// exactly when scaleX passes through ~0 (the card is edge-on / a sliver,
// so the swap is imperceptible). This is the same "squash and swap" trick
// many production flip-card implementations use specifically to avoid
// backface-visibility's flakiness altogether, and it can't have an
// engine-specific 3D rendering bug because there's no 3D rendering
// involved at any point.
export function PhotoFlipCard({
  item,
  isOwner,
  isFlipped,
  flipAnim,
  onTapCaption,
  onFlip,
}: {
  item: Photo;
  isOwner: boolean;
  isFlipped: boolean;
  flipAnim: Animated.Value;
  onTapCaption: () => void;
  onFlip: () => void;
}) {
  const box = getPolaroidViewerFrame(item);
  const cardWidth = box.width + VIEWER_POLAROID_SIDE * 2;
  const cardHeight = box.height + VIEWER_POLAROID_TOP + VIEWER_POLAROID_BOTTOM;

  // Shared by both faces — squeezes the card horizontally to nothing at
  // the halfway point (90) and back out to full width by the end (180),
  // a symmetric "V". Applied to BOTH faces identically; which one is
  // actually visible at any moment is entirely down to the opacity
  // interpolations below, not this.
  const scaleX = flipAnim.interpolate({
    inputRange: [0, 90, 180],
    outputRange: [1, 0, 1],
  });

  // The actual face-swap mechanism — snaps each face's opacity to 0/1
  // right at the moment scaleX hits (or is closest to) zero, so swapping
  // which content is showing happens while the card is visually a sliver,
  // not a visible pop. This is the ONLY thing determining which face is
  // showing — no transform, rotation, or backface trick is involved.
  const frontOpacity = flipAnim.interpolate({
    inputRange: [0, 89, 90, 180],
    outputRange: [1, 1, 0, 0],
  });
  const backOpacity = flipAnim.interpolate({
    inputRange: [0, 90, 91, 180],
    outputRange: [0, 0, 1, 1],
  });

  return (
    <View style={{ width: cardWidth, height: cardHeight }}>
      {/* Front — the photo itself, plus its caption strip. `pointerEvents`
          is toggled explicitly here rather than relying on
          `backfaceVisibility: hidden` alone — that CSS property hides
          PAINTING on web, but several browsers still deliver clicks/taps
          to a backface-hidden element if it's the topmost one in the DOM
          (the back face below is rendered after this one, so it stacks
          on top). Without this, taps meant for "+ Add a caption" land on
          the invisible back face instead and silently do nothing. */}
      <Animated.View
        style={[
          styles.polaroidViewerCard,
          styles.flipFace,
          {
            opacity: frontOpacity,
            transform: [{ scaleX }],
          },
        ]}
        pointerEvents={isFlipped ? "none" : "auto"}
      >
        <View style={[styles.polaroidViewerImageBox, box]}>
          <Image
            source={{ uri: item.url, cacheKey: item.key }}
            style={styles.polaroidViewerImage}
            contentFit="contain"
            cachePolicy="memory-disk"
            recyclingKey={item.key}
            transition={{ duration: 250, effect: "cross-dissolve" }}
          />
        </View>
        <CaptionStrip
          caption={item.caption}
          interactive={isOwner}
          onTap={onTapCaption}
          onSeeMore={onFlip}
          availableWidth={cardWidth}
        />
      </Animated.View>

      {/* Back — a white card, same as the front, that just displays the
          full caption. Owner-only edit affordance (the pencil button
          below); everyone else just gets a read-only reveal of the full
          text, which is exactly what a photo recipient needs too. Same
          pointerEvents reasoning as the front face, mirrored. */}
      <Animated.View
        style={[
          styles.polaroidViewerCard,
          styles.polaroidBackCard,
          styles.flipFace,
          {
            opacity: backOpacity,
            transform: [{ scaleX }],
          },
        ]}
        pointerEvents={isFlipped ? "auto" : "none"}
      >
        {/* Scrollable rather than a plain centered Text — a caption up to
            170 characters can wrap to more lines than a smaller
            polaroid's back face has room for; without this, the extra
            lines would silently overflow past the card's own edges. */}
        <ScrollView
          style={styles.captionReadOnlyScroll}
          contentContainerStyle={styles.captionReadOnlyContent}
        >
          <Text style={styles.captionReadOnly}>
            {item.caption ?? "No caption yet"}
          </Text>
        </ScrollView>

        {/* Sibling to the ScrollView (not inside it), so it stays fixed
            in the corner regardless of scroll position for long
            captions. Shown even with no caption yet — flipping is also
            reachable via a manual flip control, not just "See more", so
            an owner can land here with nothing written and use this to
            add one. */}
        {isOwner && (
          <TouchableOpacity
            style={styles.captionEditButton}
            onPress={onTapCaption}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="pencil" size={15} color="#666" />
          </TouchableOpacity>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  polaroidViewerCard: {
    backgroundColor: "#fff",
    borderRadius: 4,
    // Deliberately NOT overflow: "hidden" here — this style also carries
    // the card's drop shadow (below), and on iOS/web, overflow: hidden on
    // the same view that has a shadow clips the shadow itself into
    // invisibility. Clipping caption content is instead scoped to just
    // the elements that hold it (polaroidCaptionStrip below, and the
    // ScrollView on the flip card's back face), which doesn't have that
    // side effect.
    paddingTop: VIEWER_POLAROID_TOP,
    paddingHorizontal: VIEWER_POLAROID_SIDE,
    // No paddingBottom here — polaroidCaptionStrip below supplies that
    // same VIEWER_POLAROID_BOTTOM height itself (as an actual row rather
    // than blank padding), since it now needs to hold text rather than
    // just being empty border.
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.28,
        shadowRadius: 20,
      },
      android: { elevation: 12 },
      web: { boxShadow: "0 12px 40px rgba(0,0,0,0.3)" } as any,
    }),
  },
  polaroidViewerImageBox: {
    overflow: "hidden",
    backgroundColor: "#fff",
  },
  polaroidViewerImage: { width: "100%", height: "100%" },
  // The polaroid's bottom border, now a real row instead of blank
  // padding — see CaptionStrip. Height matches VIEWER_POLAROID_BOTTOM
  // exactly so the card's total size is unaffected by whether there's a
  // caption or not.
  polaroidCaptionStrip: {
    height: VIEWER_POLAROID_BOTTOM,
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    // A cursive display font's natural line box can run taller than its
    // fontSize suggests (tall ascenders/descenders), which could push a
    // "single" line's paint past this row's fixed height — this clips
    // that to the row itself instead of letting it bleed onto the white
    // polaroid border below/above. numberOfLines={1} already keeps the
    // caption to one line; this is what makes that line's own edges
    // actually a hard boundary too.
    overflow: "hidden",
  },
  // Handwriting font at a smaller size than the back's caption editor —
  // this is meant to read as a scaled-down preview, not the main event.
  polaroidCaptionText: {
    fontFamily: "Caveat_700Bold",
    // Shares CAPTION_FONT_SIZE with estimateCaptionOverflows' estimate —
    // deliberately the same value, not a coincidence.
    fontSize: CAPTION_FONT_SIZE,
    lineHeight: IS_DESKTOP_WEB ? 26 : 23,
    color: "#3a3a3a",
  },
  // The empty-state prompt — dashed-underline styling (via textDecoration
  // since RN has no border-bottom-style: dashed on Text) reads as "this
  // is a fillable blank", the same visual language a paper form uses.
  polaroidCaptionPrompt: {
    fontFamily: "Caveat_700Bold",
    fontSize: IS_DESKTOP_WEB ? 22 : 19,
    color: "rgba(0,0,0,0.32)",
    textDecorationLine: "underline",
    textDecorationStyle: "dashed",
  },
  // Row holding the (possibly truncated) caption plus its "See more…"
  // chip — flexShrink on the text wrapper (below) is what lets the chip
  // stay fully visible at its own natural width instead of getting
  // squeezed off or clipped along with the caption.
  polaroidCaptionRow: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: "100%",
  },
  polaroidCaptionTextWrap: { flexShrink: 1 },
  polaroidSeeMore: {
    fontFamily: "Caveat_700Bold",
    fontSize: IS_DESKTOP_WEB ? 20 : 17,
    color: "rgba(58,58,58,0.55)",
    marginLeft: 4,
  },
  // ── Flip card ──────────────────────────────────────────────
  // Shared by both faces: stacked exactly on top of each other. No
  // backfaceVisibility here — see PhotoFlipCard's comment on why this
  // card uses a plain scaleX squash instead of a real 3D rotation, which
  // is what would have needed it.
  flipFace: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // White, matching the front card — not a separate "aged paper" tone —
  // so the back reads as the SAME polaroid, just turned over to show the
  // rest of what's written on it. Overrides just the background;
  // padding/radius/shadow are inherited by combining with
  // polaroidViewerCard in the style array, which is also what keeps the
  // two faces pixel-identical in size.
  polaroidBackCard: {
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  captionReadOnly: {
    fontFamily: "Caveat_700Bold",
    fontSize: 26,
    lineHeight: 30,
    color: "#4a3826",
    textAlign: "center",
  },
  // Owner-only pencil button on the caption's back face — subtle enough
  // not to compete with the handwritten caption text itself, but big
  // enough to tap comfortably (hitSlop extends it further still).
  captionEditButton: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.06)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 5,
  },
  // Wraps captionReadOnly — fills the back card and scrolls instead of
  // letting a long caption's extra wrapped lines overflow past the
  // card's edges.
  captionReadOnlyScroll: { width: "100%", height: "100%" },
  captionReadOnlyContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 6,
    paddingVertical: 10,
  },
});
