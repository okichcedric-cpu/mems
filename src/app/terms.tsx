import { ScrollView, StyleSheet, Text } from "react-native";

export default function TermsOfService() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Terms of Service</Text>
      <Text style={styles.date}>
        Last updated: {new Date().toLocaleDateString()}
      </Text>
      <Text style={styles.body}>
        By using Mems you agree to these terms.{"\n\n"}
        Free accounts are limited to 3 collections and 10 photos per collection.
        Pro subscriptions unlock unlimited collections and photos.{"\n\n"}
        Subscriptions are billed monthly or annually via Pesapal. You can cancel
        at any time — access continues until the end of your billing period.
        {"\n\n"}
        You retain ownership of all photos you upload. You are responsible for
        the content you share.{"\n\n"}
        We reserve the right to terminate accounts that violate these terms.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 24 },
  title: { fontSize: 24, fontWeight: "700", color: "#111", marginBottom: 8 },
  date: { fontSize: 13, color: "#999", marginBottom: 24 },
  body: { fontSize: 15, color: "#444", lineHeight: 24 },
});
