import { useEffect, useRef } from "react";
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

// ── "Long-press to select multiple" discovery sticker ────────────────
// A one-time coach mark for the grid's multi-select feature (see
// collection/[id].tsx's selectionMode) — shown at most once per device
// (see utils/featureHints.ts), pointing at the first photo in the grid.
//
// Styled as one more "sticker" pinned to the page rather than a generic
// tooltip/popover, matching the scrapbook feel already used for the
// Android Play Store badge on login.tsx (same spring pop-in, same
// handwritten Caveat caption) — this is meant to read as part of the
// app's own visual language, not as a bolted-on UI-library tooltip.
//
// No react-native-svg dependency (not installed, and adding one would
// need a native rebuild — see AGENTS.md on shipping via OTA update
// instead of a new store build wherever possible) — the pointer "tail"
// below the bubble is a plain CSS-triangle View instead of a drawn
// arrow, which reads just as clearly at this size.
export default function MultiSelectHintSticker({
  top,
  onDismiss,
}: {
  top: number;
  onDismiss: () => void;
}) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: 1,
      tension: 60,
      friction: 9,
      useNativeDriver: true,
    }).start();
  }, [anim]);

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrapper,
        { top },
        {
          opacity: anim,
          transform: [
            { rotate: "-3deg" },
            {
              scale: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [0.7, 1],
              }),
            },
          ],
        },
      ]}
    >
      <TouchableOpacity
        activeOpacity={0.85}
        style={styles.bubble}
        onPress={onDismiss}
      >
        <Text style={styles.caption}>
          Long-press a photo to select more, then share them all at once!
        </Text>
        <Text style={styles.dismissHint}>tap to dismiss</Text>
      </TouchableOpacity>
      <View style={styles.tail} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    left: 20,
    zIndex: 25,
    alignItems: "flex-start",
  },
  bubble: {
    backgroundColor: "#fff9e8",
    borderWidth: 1,
    borderColor: "#f0dfa8",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: 210,
    shadowColor: "#000",
    shadowOffset: { width: 2, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  caption: {
    fontFamily: "Caveat_700Bold",
    fontSize: 18,
    lineHeight: 21,
    color: "#333",
  },
  dismissHint: {
    fontSize: 10,
    color: "#b3a06a",
    marginTop: 4,
    textAlign: "right",
  },
  // CSS-triangle trick — a zero-size box whose only visible pixels are
  // its borders, with two sides transparent so just the top edge reads
  // as a downward-pointing arrowhead in the bubble's own fill color.
  tail: {
    marginLeft: 24,
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderTopWidth: 10,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: "#fff9e8",
  },
});
