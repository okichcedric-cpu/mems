import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import ListingGrid from "../../components/ListingGrid";
import MarketplaceShell, { marketplaceText as t, polaroid } from "../../components/MarketplaceShell";
import { CreatorProfile, getCreatorByHandle } from "../../utils/creator";
import { fetchListings, StoreListing } from "../../utils/listings";

// Public creator page: bio plus everything they have for sale.
export default function CreatorPage() {
  const router = useRouter();
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const [creator, setCreator] = useState<CreatorProfile | null | undefined>(undefined);
  const [listings, setListings] = useState<StoreListing[] | null>(null);

  useEffect(() => {
    if (!handle) return;
    getCreatorByHandle(String(handle))
      .then(setCreator)
      .catch(() => setCreator(null));
    fetchListings(String(handle))
      .then(setListings)
      .catch(() => setListings([]));
  }, [handle]);

  if (creator === undefined) {
    return (
      <MarketplaceShell title="Picture Board Marketplace">
        <ActivityIndicator color="#111" style={{ marginTop: 40 }} />
      </MarketplaceShell>
    );
  }

  if (creator === null) {
    return (
      <MarketplaceShell title="Creator not found">
        <Text style={t.heading}>Creator not found</Text>
        <TouchableOpacity onPress={() => router.replace("/marketplace" as any)}>
          <Text style={t.link}>Back to marketplace</Text>
        </TouchableOpacity>
      </MarketplaceShell>
    );
  }

  return (
    <MarketplaceShell title={`${creator.displayName} · Picture Board Marketplace`}>
      <View style={polaroid.wrapper}>
        <View style={[polaroid.card, styles.profileCard]}>
          <Text style={t.heading}>{creator.displayName}</Text>
          <Text style={t.muted}>@{creator.handle}</Text>
          <Text style={[t.body, { marginTop: 10 }]}>{creator.bio}</Text>
        </View>
      </View>

      <Text style={t.subheading}>For sale</Text>
      {listings === null && <ActivityIndicator color="#111" />}
      {listings && listings.length === 0 && (
        <Text style={t.body}>No collections for sale yet.</Text>
      )}
      {listings && listings.length > 0 && <ListingGrid listings={listings} />}
    </MarketplaceShell>
  );
}

const styles = StyleSheet.create({
  profileCard: { padding: 18 },
});
