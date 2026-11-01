import { useRouter } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import AlbumBackground from "../components/AlbumBackground";

// Shown once, straight after the first-time walkthrough (onboarding.tsx).
// Declining is always fine — the same option stays in the profile menu.
export default function MarketplaceOffer() {
  const router = useRouter();

  return (
    <AlbumBackground style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Want to sell your photography?</Text>
        <Text style={styles.body}>
          Set up a marketplace account to sell your collections on Mems. Buyers
          get instant access when they pay. You can also do this later from your
          profile menu.
        </Text>
        <TouchableOpacity
          style={styles.primary}
          onPress={() => router.replace("/creator-setup")}
        >
          <Text style={styles.primaryText}>Yes, set up my marketplace account</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondary} onPress={() => router.replace("/")}>
          <Text style={styles.secondaryText}>No thanks, just my memories</Text>
        </TouchableOpacity>
      </View>
    </AlbumBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 2,
    padding: 28,
    width: "100%",
    maxWidth: 440,
    gap: 16,
  },
  title: { fontFamily: "Caveat_700Bold", fontSize: 34, lineHeight: 38, color: "#222", textAlign: "center" },
  body: { fontSize: 15, color: "#666", lineHeight: 22, textAlign: "center" },
  primary: {
    backgroundColor: "#111",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  secondary: { paddingVertical: 12, alignItems: "center" },
  secondaryText: { color: "#666", fontSize: 15, fontWeight: "500" },
});
