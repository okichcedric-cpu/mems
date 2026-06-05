import { ScrollView, StyleSheet, Text } from "react-native";

export default function PrivacyPolicy() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Privacy Policy</Text>
      <Text style={styles.date}>
        Last updated: {new Date().toLocaleDateString()}
      </Text>
      <Text style={styles.body}>
        Mems ("we", "our", "us") is committed to protecting your privacy.
        {"\n\n"}
        We collect your email address and photos you choose to upload. Your
        photos are stored securely on AWS S3 and are only accessible to you and
        people you explicitly share them with.{"\n\n"}
        We do not sell your data to third parties.{"\n\n"}
        You can delete your account and all associated data at any time by
        contacting us at contact@mems-app.com.
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
