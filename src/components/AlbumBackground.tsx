import { ImageBackground, StyleProp, StyleSheet, ViewStyle } from "react-native";

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
// assets/images/paper-texture.jpg is a small (512x512) tileable grain
// generated offline — seamless FFT-filtered mottling plus a faint woven-
// fiber pattern layered over a warm cream base — repeated via resizeMode
// "repeat" rather than stretched to fill the screen, so it reads as a
// continuous material at any screen size instead of one big soft-focus
// photo. `fallback` is the same base tone the texture was built around, so
// there's no flash of white while the tile image decodes on a slow device.
export default function AlbumBackground({ style, children }: Props) {
  return (
    <ImageBackground
      source={require("@/assets/images/paper-texture.jpg")}
      resizeMode="repeat"
      style={[styles.fallback, style]}
    >
      {children}
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  fallback: { backgroundColor: "#eee5cf" },
});
