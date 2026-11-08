import PushPin from "../../components/PushPin";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import MarketplaceShell, { marketplaceText as t, polaroid } from "../../components/MarketplaceShell";
import { fetchPurchasedCollection, PurchasedPhoto } from "../../utils/orders";

// A purchased collection: full-quality photos, no watermark.
export default function PurchasedCollection() {
  const router = useRouter();
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const { width } = useWindowDimensions();
  const [data, setData] = useState<{ title: string; photos: PurchasedPhoto[] } | null | undefined>(undefined);

  useEffect(() => {
    if (!orderId) return;
    fetchPurchasedCollection(String(orderId))
      .then((r) => setData({ title: r.order.title, photos: r.photos }))
      .catch(() => setData(null));
  }, [orderId]);

  function open(url: string | null) {
    if (!url) return;
    if (Platform.OS === "web") window.open(url, "_blank", "noopener");
    else Linking.openURL(url);
  }

  if (data === undefined) {
    return (
      <MarketplaceShell title="My purchase">
        <ActivityIndicator color="#111" style={{ marginTop: 40 }} />
      </MarketplaceShell>
    );
  }
  if (data === null) {
    return (
      <MarketplaceShell title="My purchase">
        <Text style={t.heading}>Purchase not available</Text>
        <Text style={t.body}>We couldn't open this purchase. If you just paid, wait a moment and try again.</Text>
        <TouchableOpacity onPress={() => router.replace("/purchases" as any)}>
          <Text style={t.link}>My purchases</Text>
        </TouchableOpacity>
      </MarketplaceShell>
    );
  }

  const cols = width >= 900 ? 3 : width >= 560 ? 2 : 1;
  const columns: PurchasedPhoto[][] = Array.from({ length: cols }, () => []);
  data.photos.forEach((p, i) => columns[i % cols].push(p));

  return (
    <MarketplaceShell title={`${data.title} · My purchase`}>
      <TouchableOpacity onPress={() => router.push("/purchases" as any)}>
        <Text style={t.link}>← My purchases</Text>
      </TouchableOpacity>
      <Text style={t.heading}>{data.title}</Text>
      <Text style={t.muted}>
        {data.photos.length} {data.photos.length === 1 ? "photo" : "photos"} · tap a photo to open it
        full size, then save it
      </Text>
      <View style={{ flexDirection: "row", gap: 16 }}>
        {columns.map((col, ci) => (
          <View key={ci} style={{ flex: 1, gap: 16 }}>
            {col.map((p) => (
              <TouchableOpacity
                key={p.name}
                style={polaroid.wrapper}
                activeOpacity={0.9}
                onPress={() => open(p.url)}
              >
        <PushPin />
                <View style={polaroid.card}>
                  <View style={styles.photoBox}>
                    {(p.thumbUrl || p.url) && (
                      <Image
                        source={{ uri: (p.thumbUrl || p.url) as string }}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                      />
                    )}
                  </View>
                  <View style={{ height: 24 }} />
                </View>
              </TouchableOpacity>
            ))}
          </View>
        ))}
      </View>
    </MarketplaceShell>
  );
}

const styles = StyleSheet.create({
  photoBox: { width: "100%", aspectRatio: 1, backgroundColor: "#e8e8e8", overflow: "hidden" },
});
