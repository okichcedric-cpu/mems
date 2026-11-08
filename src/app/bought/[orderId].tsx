import PushPin from "../../components/PushPin";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import AlbumBackground from "../../components/AlbumBackground";
import { polaroid } from "../../components/MarketplaceShell";
import { fetchPurchasedCollection, PurchasedPhoto } from "../../utils/orders";

// A collection bought on the marketplace, opened from the home screen
// (web and app). Deliberately NOT a marketplace screen: it lives in the
// app's own album styling and works on native, where the marketplace itself
// is unavailable.
export default function BoughtCollection() {
  const router = useRouter();
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const { width, height } = useWindowDimensions();
  const [data, setData] = useState<{ title: string; photos: PurchasedPhoto[] } | null | undefined>(undefined);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!orderId) return;
    fetchPurchasedCollection(String(orderId))
      .then((r) => setData({ title: r.order.title, photos: r.photos }))
      .catch(() => setData(null));
  }, [orderId]);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }

  const header = (
    <View style={styles.header}>
      <TouchableOpacity onPress={goBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="arrow-back" size={22} color="#111" />
      </TouchableOpacity>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {data?.title ?? ""}
      </Text>
    </View>
  );

  if (data === undefined) {
    return (
      <AlbumBackground style={{ flex: 1 }}>
        {header}
        <ActivityIndicator color="#111" style={{ marginTop: 40 }} />
      </AlbumBackground>
    );
  }
  if (data === null) {
    return (
      <AlbumBackground style={{ flex: 1 }}>
        {header}
        <Text style={styles.message}>
          We couldn't open this purchase. If you just paid, wait a moment and try again.
        </Text>
      </AlbumBackground>
    );
  }

  const cols = width >= 900 ? 3 : 2;
  const columns: { p: PurchasedPhoto; i: number }[][] = Array.from({ length: cols }, () => []);
  data.photos.forEach((p, i) => columns[i % cols].push({ p, i }));
  const current = openIndex !== null ? data.photos[openIndex] : null;

  return (
    <AlbumBackground style={{ flex: 1 }}>
      {header}
      <ScrollView contentContainerStyle={styles.grid}>
        <View style={{ flexDirection: "row", gap: 14 }}>
          {columns.map((col, ci) => (
            <View key={ci} style={{ flex: 1, gap: 14 }}>
              {col.map(({ p, i }) => (
                <TouchableOpacity
                  key={p.name}
                  style={polaroid.wrapper}
                  activeOpacity={0.9}
                  onPress={() => setOpenIndex(i)}
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
                    <View style={{ height: 22 }} />
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>

      <Modal visible={current !== null} animationType="fade" onRequestClose={() => setOpenIndex(null)}>
        <View style={styles.viewer}>
          {current && (
            <Image
              source={{ uri: (current.url || current.thumbUrl) as string }}
              style={{ width, height: height - 120 }}
              contentFit="contain"
            />
          )}
          <View style={styles.viewerBar}>
            <TouchableOpacity
              onPress={() => setOpenIndex((n) => (n !== null && n > 0 ? n - 1 : n))}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="chevron-back" size={28} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.viewerCount}>
              {openIndex !== null ? openIndex + 1 : 0} / {data.photos.length}
            </Text>
            <TouchableOpacity
              onPress={() =>
                setOpenIndex((n) => (n !== null && n < data.photos.length - 1 ? n + 1 : n))
              }
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="chevron-forward" size={28} color="#fff" />
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.viewerClose}
            onPress={() => setOpenIndex(null)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
        </View>
      </Modal>
    </AlbumBackground>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 12,
  },
  headerTitle: { flex: 1, fontFamily: "Caveat_700Bold", fontSize: 30, color: "#222" },
  message: { padding: 24, fontSize: 15, color: "#444", lineHeight: 22 },
  grid: { padding: 16, paddingBottom: 60, width: "100%", maxWidth: 900, alignSelf: "center" },
  photoBox: { width: "100%", aspectRatio: 1, backgroundColor: "#e8e8e8", overflow: "hidden" },
  viewer: { flex: 1, backgroundColor: "#000", justifyContent: "center" },
  viewerBar: {
    position: "absolute",
    bottom: 40,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 28,
  },
  viewerCount: { color: "#fff", fontSize: 15 },
  viewerClose: { position: "absolute", top: 54, right: 20 },
});
