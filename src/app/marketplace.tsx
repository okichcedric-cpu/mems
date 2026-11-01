import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import ListingGrid from "../components/ListingGrid";
import MarketplaceShell, { marketplaceText as t, polaroid } from "../components/MarketplaceShell";
import { CreatorProfile, listCreators } from "../utils/creator";
import { fetchListings, StoreListing } from "../utils/listings";

// Public storefront home (marketplace.mems-app.com).
export default function Marketplace() {
  const router = useRouter();
  const [listings, setListings] = useState<StoreListing[] | null>(null);
  const [creators, setCreators] = useState<CreatorProfile[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchListings()
      .then(setListings)
      .catch(() => setFailed(true));
    listCreators(12)
      .then(setCreators)
      .catch(() => {});
  }, []);

  return (
    <MarketplaceShell title="Mems Marketplace" plain>
      <Text style={t.sectionLabel}>Collections</Text>

      {listings === null && !failed && <ActivityIndicator color="#111" style={{ marginTop: 32 }} />}
      {failed && <Text style={t.muted}>Couldn't load the marketplace. Please try again.</Text>}
      {listings && listings.length === 0 && (
        <Text style={[t.body, styles.empty]}>Nothing for sale yet. Check back soon.</Text>
      )}
      {listings && listings.length > 0 && <ListingGrid listings={listings} />}

      {creators.length > 0 && (
        <>
          <Text style={[t.sectionLabel, { marginTop: 10 }]}>Creators</Text>
          <View style={styles.creatorRow}>
            {creators.map((c) => (
              <TouchableOpacity
                key={c.userId}
                style={[polaroid.wrapper, styles.creatorWrap]}
                onPress={() => router.push(`/creator/${c.handle}` as any)}
              >
                <View style={[polaroid.card, styles.creatorCard]}>
                  <Text style={styles.creatorName} numberOfLines={1}>
                    {c.displayName}
                  </Text>
                  <Text style={t.muted}>@{c.handle}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}
    </MarketplaceShell>
  );
}

const styles = StyleSheet.create({
  empty: { textAlign: "center", marginTop: 24 },
  creatorRow: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  creatorWrap: { minWidth: 150 },
  creatorCard: { paddingHorizontal: 14, paddingVertical: 10 },
  creatorName: { fontFamily: "Caveat_700Bold", fontSize: 22, color: "#222" },
});
