import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import ListingGrid from "../components/ListingGrid";
import MarketplaceShell, { marketplaceText as t, polaroid } from "../components/MarketplaceShell";
import { CreatorProfile, listCreators, searchCreators } from "../utils/creator";
import { fetchListings, StoreListing } from "../utils/listings";

// Public storefront home (marketplace.mems-app.com).
export default function Marketplace() {
  const router = useRouter();
  const [listings, setListings] = useState<StoreListing[] | null>(null);
  const [creators, setCreators] = useState<CreatorProfile[]>([]);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CreatorProfile[] | null>(null);
  const [searching, setSearching] = useState(false);
  const reqId = useRef(0);

  // Live search: waits briefly after the last keystroke, ignores stale replies.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      reqId.current++;
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = ++reqId.current;
    const timer = setTimeout(() => {
      searchCreators(q)
        .then((r) => reqId.current === id && setResults(r))
        .catch(() => reqId.current === id && setResults([]))
        .finally(() => reqId.current === id && setSearching(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);
  const isSearching = query.trim().length > 0;

  useEffect(() => {
    fetchListings()
      .then(setListings)
      .catch(() => setFailed(true));
    listCreators(12)
      .then(setCreators)
      .catch(() => {});
  }, []);

  return (
    <MarketplaceShell title="Picture Board Marketplace" plain>
      <View style={styles.searchBox}>
        <Ionicons name="search-outline" size={18} color="#888" />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search sellers by name or @handle"
          placeholderTextColor="#999"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {searching && <ActivityIndicator size="small" color="#888" />}
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={18} color="#aaa" />
          </TouchableOpacity>
        )}
      </View>

      {isSearching ? (
        <>
          <Text style={t.sectionLabel}>Sellers</Text>
          {results && results.length === 0 && !searching && (
            <Text style={[t.body, styles.empty]}>No sellers match "{query.trim()}".</Text>
          )}
          <View style={styles.creatorRow}>
            {(results ?? []).map((c) => (
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
      ) : (
      <>
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
      </>
      )}
    </MarketplaceShell>
  );
}

const styles = StyleSheet.create({
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: "#fff",
  },
  searchInput: { flex: 1, fontSize: 16, color: "#111", padding: 0, outlineStyle: "none" as any },
  empty: { textAlign: "center", marginTop: 24 },
  creatorRow: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  creatorWrap: { minWidth: 150 },
  creatorCard: { paddingHorizontal: 14, paddingVertical: 10 },
  creatorName: { fontFamily: "Caveat_700Bold", fontSize: 22, color: "#222" },
});
