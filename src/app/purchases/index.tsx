import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import MarketplaceShell, { marketplaceText as t, polaroid } from "../../components/MarketplaceShell";
import { formatPrice } from "../../utils/listings";
import { fetchMyPurchases, Order } from "../../utils/orders";

// The buyer's library: every collection they've paid for.
export default function Purchases() {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchMyPurchases()
      .then(setOrders)
      .catch(() => setFailed(true));
  }, []);

  return (
    <MarketplaceShell title="My purchases">
      <Text style={t.heading}>My purchases</Text>
      {orders === null && !failed && <ActivityIndicator color="#111" />}
      {failed && <Text style={t.muted}>Couldn't load your purchases. Please try again.</Text>}
      {orders && orders.length === 0 && (
        <Text style={t.body}>You haven't bought anything yet.</Text>
      )}
      {orders?.map((o) => (
        <TouchableOpacity
          key={o.id}
          style={polaroid.wrapper}
          onPress={() => router.push(`/purchases/${o.id}` as any)}
        >
          <View style={[polaroid.card, styles.row]}>
            <Text style={styles.title} numberOfLines={1}>
              {o.title}
            </Text>
            <Text style={t.muted}>{formatPrice(o.amount, o.currency)}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </MarketplaceShell>
  );
}

const styles = StyleSheet.create({
  row: { padding: 16, gap: 2 },
  title: { fontFamily: "Caveat_700Bold", fontSize: 26, color: "#222" },
});
