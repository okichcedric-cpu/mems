import React from "react";
import {
  Dimensions,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const FLIP_DURATION = 600;
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.2;

type Props = {
  pages: React.ReactNode[];
  currentPage: number;
  onPageChange: (page: number) => void;
};

export default function PageFlip({ pages, currentPage, onPageChange }: Props) {
  const flipProgress = useSharedValue(0);
  const isFlipping = useSharedValue(false);
  const flipDir = useSharedValue<1 | -1>(1);

  function commitFlip(direction: 1 | -1, targetPage: number) {
    "worklet";
    if (isFlipping.value) return;
    flipDir.value = direction;
    isFlipping.value = true;
    flipProgress.value = withTiming(
      1,
      { duration: FLIP_DURATION, easing: Easing.inOut(Easing.cubic) },
      (finished) => {
        "worklet";
        if (finished) {
          runOnJS(onPageChange)(targetPage);
          flipProgress.value = 0;
          isFlipping.value = false;
        }
      },
    );
  }

  function snapBack() {
    "worklet";
    flipProgress.value = withTiming(
      0,
      {
        duration: 300,
        easing: Easing.out(Easing.cubic),
      },
      () => {
        "worklet";
        isFlipping.value = false;
      },
    );
  }

  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-15, 15]) // ← requires deliberate horizontal movement
    .failOffsetY([-10, 10]) // ← fails if user moves vertically (scroll intent)
    .onUpdate((e) => {
      "worklet";
      if (isFlipping.value) return;
      const dx = e.translationX;
      if (dx < 0 && currentPage < pages.length - 1) {
        flipDir.value = 1;
        flipProgress.value = Math.min(
          Math.abs(dx) / (SCREEN_WIDTH * 0.7),
          0.45,
        );
      } else if (dx > 0 && currentPage > 0) {
        flipDir.value = -1;
        flipProgress.value = Math.min(dx / (SCREEN_WIDTH * 0.7), 0.45);
      }
    })
    .onEnd((e) => {
      "worklet";
      const dx = e.translationX;
      const vx = e.velocityX;
      if (
        (dx < -SWIPE_THRESHOLD || vx < -600) &&
        currentPage < pages.length - 1
      ) {
        commitFlip(1, currentPage + 1);
      } else if ((dx > SWIPE_THRESHOLD || vx > 600) && currentPage > 0) {
        commitFlip(-1, currentPage - 1);
      } else {
        snapBack();
      }
    });

  const outgoingStyle = useAnimatedStyle(() => {
    const tx =
      flipDir.value === 1
        ? interpolate(flipProgress.value, [0, 1], [0, -SCREEN_WIDTH])
        : interpolate(flipProgress.value, [0, 1], [0, SCREEN_WIDTH]);
    return {
      transform: [{ translateX: tx }],
      zIndex: 2,
    };
  });

  const incomingStyle = useAnimatedStyle(() => {
    const startX = flipDir.value === 1 ? SCREEN_WIDTH : -SCREEN_WIDTH;
    const tx = interpolate(flipProgress.value, [0, 1], [startX, 0]);
    return {
      transform: [{ translateX: tx }],
      zIndex: 1,
    };
  });

  const targetIndex =
    flipDir.value === 1
      ? Math.min(currentPage + 1, pages.length - 1)
      : Math.max(currentPage - 1, 0);

  return (
    <View style={styles.container}>
      <GestureDetector gesture={swipeGesture}>
        <View style={styles.book}>
          {/* Incoming page */}
          <Animated.View style={[StyleSheet.absoluteFill, incomingStyle]}>
            {pages[targetIndex]}
          </Animated.View>

          {/* Outgoing page */}
          <Animated.View style={[StyleSheet.absoluteFill, outgoingStyle]}>
            {pages[currentPage]}
          </Animated.View>

          {/* ← removed the blocking overlay entirely */}
        </View>
      </GestureDetector>

      {/* Navigation */}
      {pages.length > 1 && (
        <View style={styles.nav}>
          <TouchableOpacity
            style={[
              styles.arrowButton,
              currentPage === 0 && styles.arrowDisabled,
            ]}
            onPress={() => {
              if (currentPage > 0) commitFlip(-1, currentPage - 1);
            }}
            disabled={currentPage === 0}
          >
            <Text style={styles.arrowText}>←</Text>
          </TouchableOpacity>

          <View style={styles.dots}>
            {pages.map((_, i) => (
              <View
                key={i}
                style={[styles.dot, i === currentPage && styles.dotActive]}
              />
            ))}
          </View>

          <TouchableOpacity
            style={[
              styles.arrowButton,
              currentPage === pages.length - 1 && styles.arrowDisabled,
            ]}
            onPress={() => {
              if (currentPage < pages.length - 1)
                commitFlip(1, currentPage + 1);
            }}
            disabled={currentPage === pages.length - 1}
          >
            <Text style={styles.arrowText}>→</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  book: {
    flex: 1,
    overflow: "hidden",
    ...Platform.select({
      web: { userSelect: "none", cursor: "grab" } as any,
    }),
  },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    gap: 16,
  },
  arrowButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#111",
    alignItems: "center",
    justifyContent: "center",
  },
  arrowDisabled: { backgroundColor: "#ddd" },
  arrowText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  dots: { flexDirection: "row", gap: 6, alignItems: "center" },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#ddd" },
  dotActive: { backgroundColor: "#111", width: 18, borderRadius: 3 },
});
