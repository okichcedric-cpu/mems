import { Image } from "expo-image";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";

type Props = {
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

// Shared "old photo album" backdrop — used everywhere a screen previously
// had a plain flat background: the home screen grid, the inside-a-collection
// grid, and the full-screen single-photo viewer. One component so those
// three screens can't quietly drift out of visual sync with each other over
// time the way three separate copy-pasted styles eventually would.
//
// assets/images/paper-texture.jpg is a large (1200x2000) generated aged-
// paper texture — soft blotches plus a faint woven-fiber pattern over a
// warm cream base — sized comfortably larger than any real phone/tablet
// screen.
//
// Deliberately NOT <ImageBackground>: that component sizes its internal
// image off its own measured width/height and applies a computed
// background-size, which left a sliver of the container's flat fallback
// colour uncovered along the right edge (ImageBackground's layout-then-
// paint timing, especially on web, doesn't always match the box's final
// size exactly). A plain absolutely-positioned Image pinned to all four
// edges (top/left/right/bottom: 0) has no such gap — it's stretched
// directly against the container's actual edges rather than a
// separately-computed size, so there's nothing for it to fall short of.
export default function AlbumBackground({ style, children }: Props) {
  return (
    <View style={[styles.fallback, style]}>
      <Image
        source={require("@/assets/images/paper-texture.jpg")}
        contentFit="cover"
        style={StyleSheet.absoluteFillObject}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { backgroundColor: "#eee5cf" },
});
