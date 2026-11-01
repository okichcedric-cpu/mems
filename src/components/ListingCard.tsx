import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { formatPrice, StoreListing } from "../utils/listings";
import { polaroid } from "./MarketplaceShell";

// A listing, styled like a collection polaroid on the home screen:
// white card, photo collage on top, handwritten title underneath.
export default function ListingCard({ listing }: { listing: StoreListing }) {
  const router = useRouter();
  const [a, b, c] = listing.previews;

  return (
    <TouchableOpacity
      style={[polaroid.wrapper, styles.wrapper]}
      activeOpacity={0.9}
      onPress={() => router.push(`/listing/${listing.id}` as any)}
    >
      <View style={polaroid.card}>
        <View style={styles.photoArea}>
          {a ? (
            <View style={styles.collage}>
              <Image source={{ uri: a }} style={styles.left} contentFit="cover" />
              {(b || c) && (
                <View style={styles.right}>
                  {b && <Image source={{ uri: b }} style={styles.rightTile} contentFit="cover" />}
                  {c && <Image source={{ uri: c }} style={styles.rightTile} contentFit="cover" />}
                </View>
              )}
            </View>
          ) : null}
          <View style={styles.priceTag}>
            <Text style={styles.priceText}>{formatPrice(listing.priceAmount, listing.currency)}</Text>
          </View>
        </View>
        <View style={styles.caption}>
          <Text style={styles.title} numberOfLines={1}>
            {listing.title}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            by {listing.seller.displayName} · {listing.photoCount}{" "}
            {listing.photoCount === 1 ? "photo" : "photos"}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrapper: { width: "100%" },
  photoArea: {
    position: "relative",
    width: "100%",
    aspectRatio: 1,
    overflow: "hidden",
    backgroundColor: "#e8e8e8",
  },
  collage: { ...StyleSheet.absoluteFillObject, flexDirection: "row", gap: 3 },
  left: { flex: 1.1 },
  right: { flex: 0.9, gap: 3 },
  rightTile: { flex: 1 },
  priceTag: {
    position: "absolute",
    right: 8,
    bottom: 8,
    backgroundColor: "rgba(17,17,17,0.85)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  priceText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  caption: { paddingHorizontal: 6, paddingTop: 6, paddingBottom: 10 },
  title: { fontFamily: "Caveat_700Bold", fontSize: 22, lineHeight: 24, color: "#222" },
  meta: { fontSize: 11, color: "#999", marginTop: 1 },
});
