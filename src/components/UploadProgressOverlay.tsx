import { useEffect, useRef } from "react";
import {
  Animated,
  Modal,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";

type Props = {
  visible: boolean;
  total: number;
  completed: number;
  // Optional — customise the wording, e.g. "Uploading photos" vs "Creating collection"
  label?: string;
};

export default function UploadProgressOverlay({
  visible,
  total,
  completed,
  label = "Uploading photos",
}: Props) {
  const progressAnim = useRef(new Animated.Value(0)).current;
  const spinAnim = useRef(new Animated.Value(0)).current;

  const progress = total > 0 ? Math.min(completed / total, 1) : 0;

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: progress,
      duration: 280,
      useNativeDriver: false, // width animation — can't use native driver
    }).start();
  }, [progress]);

  useEffect(() => {
    if (!visible) return;
    const spin = Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 900,
        useNativeDriver: true,
      }),
    );
    spin.start();
    return () => spin.stop();
  }, [visible]);

  if (!visible) return null;

  const spinInterpolate = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const widthInterpolate = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  const isIndeterminate = total === 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {/* Spinner */}
          <Animated.View
            style={[
              styles.spinner,
              { transform: [{ rotate: spinInterpolate }] },
            ]}
          />

          <Text style={styles.title}>{label}</Text>

          {isIndeterminate ? (
            <Text style={styles.subtitle}>Preparing your photos…</Text>
          ) : (
            <>
              <Text style={styles.subtitle}>
                {completed} of {total} uploaded
              </Text>
              <View style={styles.progressTrack}>
                <Animated.View
                  style={[styles.progressFill, { width: widthInterpolate }]}
                />
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingVertical: 28,
    paddingHorizontal: 24,
    alignItems: "center",
    ...Platform.select({
      web: { boxShadow: "0 12px 40px rgba(0,0,0,0.25)" } as any,
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.2,
        shadowRadius: 20,
      },
      android: { elevation: 12 },
    }),
  },
  spinner: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 3,
    borderColor: "#e8e8e8",
    borderTopColor: "#111",
    marginBottom: 16,
  },
  title: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: "#888",
    marginBottom: 16,
  },
  progressTrack: {
    width: "100%",
    height: 6,
    borderRadius: 3,
    backgroundColor: "#eee",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#4AE8A0",
    borderRadius: 3,
  },
});
