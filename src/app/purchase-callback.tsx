import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import MarketplaceShell, { marketplaceText as t, polaroid } from "../components/MarketplaceShell";
import { checkOrder } from "../utils/orders";

// Pesapal sends the buyer back here after paying. We ask the server to
// verify the payment (rather than trusting the URL), then open the purchase.
export default function PurchaseCallback() {
  const router = useRouter();
  const { order } = useLocalSearchParams<{ order?: string }>();
  const [state, setState] = useState<"checking" | "failed" | "review" | "slow">("checking");

  useEffect(() => {
    if (!order) {
      router.replace("/purchases" as any);
      return;
    }
    let cancelled = false;
    let tries = 0;
    async function poll() {
      while (!cancelled && tries < 12) {
        tries++;
        try {
          const { status } = await checkOrder(String(order));
          if (cancelled) return;
          if (status === "paid") {
            router.replace(`/purchases/${order}` as any);
            return;
          }
          if (status === "failed") return setState("failed");
          if (status === "needs_review") return setState("review");
        } catch {
          // transient; keep trying
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      if (!cancelled) setState("slow");
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [order]);

  return (
    <MarketplaceShell title="Confirming payment">
      <View style={polaroid.wrapper}>
        <View style={[polaroid.card, styles.card]}>
          {state === "checking" && (
            <>
              <ActivityIndicator color="#111" />
              <Text style={t.subheading}>Confirming your payment…</Text>
              <Text style={t.muted}>This usually takes a few seconds.</Text>
            </>
          )}
          {state === "failed" && (
            <>
              <Text style={t.subheading}>Payment didn't go through</Text>
              <Text style={t.body}>You haven't been charged. You can try again from the listing.</Text>
            </>
          )}
          {state === "review" && (
            <>
              <Text style={t.subheading}>We're checking your payment</Text>
              <Text style={t.body}>
                Something didn't match up, so we're reviewing it. Email contact@mems-app.com
                with your order number ({String(order)}) and we'll sort it out.
              </Text>
            </>
          )}
          {state === "slow" && (
            <>
              <Text style={t.subheading}>Still confirming…</Text>
              <Text style={t.body}>
                Your payment is taking longer than usual to confirm. Your purchase will
                appear in My purchases as soon as it does, and we'll email you.
              </Text>
            </>
          )}
          {state !== "checking" && (
            <TouchableOpacity onPress={() => router.replace("/purchases" as any)}>
              <Text style={t.link}>Go to my purchases</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </MarketplaceShell>
  );
}

const styles = StyleSheet.create({
  card: { padding: 24, alignItems: "center", gap: 12 },
});
