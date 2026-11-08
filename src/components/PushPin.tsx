import { StyleSheet, View } from "react-native";

// Red push pin, like the one in the app icon. Absolutely positioned at the
// top-centre of whatever polaroid wrapper it's placed in. Never takes touches.
export default function PushPin({ size = 18, top = -7 }: { size?: number; top?: number }) {
  return (
    <View
      pointerEvents="none"
      style={[styles.holder, { top, left: "50%", marginLeft: -size / 2, width: size, height: size }]}
    >
      <View style={[styles.shadow, { width: size, height: size, borderRadius: size / 2, left: size * 0.25, top: size * 0.25 }]} />
      <View style={[styles.head, { width: size, height: size, borderRadius: size / 2 }]}>
        <View
          style={{
            position: "absolute",
            top: size * 0.16,
            left: size * 0.22,
            width: size * 0.32,
            height: size * 0.22,
            borderRadius: size * 0.16,
            backgroundColor: "rgba(255,255,255,0.65)",
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  holder: { position: "absolute", zIndex: 20, elevation: 12 },
  shadow: { position: "absolute", backgroundColor: "rgba(0,0,0,0.28)" },
  head: {
    backgroundColor: "#E5484D",
    borderWidth: 1.5,
    borderColor: "#B3262C",
  },
});
