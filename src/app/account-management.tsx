import { useAuth } from "@/contexts/AuthContext";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { supabase } from "../utils/supabase";

const SCREEN_WIDTH = Dimensions.get("window").width;
const IS_WEB = Platform.OS === "web";
const IS_DESKTOP = IS_WEB && SCREEN_WIDTH >= 768;

export default function AccountManagementPage() {
  const router = useRouter();
  const { session } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [updating, setUpdating] = useState(false);

  async function handleUpdatePassword() {
    if (password.length < 8) {
      const msg = "Password must be at least 8 characters.";
      IS_WEB ? window.alert(msg) : Alert.alert("Weak password", msg);
      return;
    }
    if (password !== confirmPassword) {
      const msg = "Passwords do not match.";
      IS_WEB ? window.alert(msg) : Alert.alert("Error", msg);
      return;
    }

    setUpdating(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setPassword("");
      setConfirmPassword("");
      const msg = "Your password has been updated.";
      IS_WEB ? window.alert(msg) : Alert.alert("Success", msg);
    } catch (error: any) {
      console.error("Update password error:", error.message);
      const msg = "Could not update your password. Please try again.";
      IS_WEB ? window.alert(msg) : Alert.alert("Error", msg);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/");
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Account Management</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.page, IS_DESKTOP && styles.pageDesktop]}
      >
        {/* ── Change password ── */}
        <View style={[styles.card, IS_DESKTOP && styles.cardDesktop]}>
          <Text style={styles.icon}>🔑</Text>
          <Text style={styles.title}>Change your password</Text>
          {session?.user?.email && (
            <Text style={styles.sub}>
              Signed in as{" "}
              <Text style={styles.signedInEmail}>{session.user.email}</Text>
            </Text>
          )}

          <TextInput
            style={styles.input}
            placeholder="New password"
            placeholderTextColor="#999"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
          />
          <TextInput
            style={styles.input}
            placeholder="Confirm new password"
            placeholderTextColor="#999"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            autoCapitalize="none"
          />

          <TouchableOpacity
            style={[styles.primaryButton, updating && { opacity: 0.7 }]}
            onPress={handleUpdatePassword}
            disabled={updating}
          >
            {updating ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.primaryButtonText}>Update password</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* ── Deactivate account — unchanged flow, just relocated here ── */}
        <View style={[styles.card, IS_DESKTOP && styles.cardDesktop]}>
          <Text style={styles.icon}>⚠️</Text>
          <Text style={styles.title}>Deactivate account</Text>
          <Text style={styles.sub}>
            Permanently delete your account, collections, and photos. This
            cannot be undone.
          </Text>

          <TouchableOpacity
            style={styles.dangerButton}
            onPress={() => router.push("/delete-account")}
          >
            <Text style={styles.dangerButtonText}>Deactivate account</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f7f7f9" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: IS_WEB ? 20 : 56,
    paddingBottom: 16,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: "#111" },

  page: { padding: 20, paddingBottom: 60, alignItems: "center", gap: 20 },
  pageDesktop: { paddingTop: 48 },

  card: {
    width: "100%",
    maxWidth: 480,
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 28,
    borderWidth: 1,
    borderColor: "#eee",
    alignItems: "center",
    ...Platform.select({
      web: { boxShadow: "0 4px 20px rgba(0,0,0,0.05)" } as any,
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.05,
        shadowRadius: 12,
      },
      android: { elevation: 2 },
    }),
  },
  cardDesktop: { padding: 36 },

  icon: { fontSize: 36, marginBottom: 10 },
  title: {
    fontSize: 19,
    fontWeight: "800",
    color: "#111",
    textAlign: "center",
    marginBottom: 8,
  },
  sub: {
    fontSize: 13.5,
    color: "#666",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 20,
  },
  signedInEmail: { color: "#111", fontWeight: "600" },

  input: {
    width: "100%",
    borderWidth: 1,
    borderColor: "#e0e0e0",
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: "#111",
    marginBottom: 12,
    backgroundColor: "#fafafa",
  },

  primaryButton: {
    backgroundColor: "#111",
    borderRadius: 12,
    paddingVertical: 15,
    width: "100%",
    alignItems: "center",
    marginTop: 4,
  },
  primaryButtonText: { color: "#fff", fontSize: 15, fontWeight: "600" },

  dangerButton: {
    backgroundColor: "rgba(220,40,40,0.9)",
    borderRadius: 12,
    paddingVertical: 15,
    paddingHorizontal: 24,
    width: "100%",
    alignItems: "center",
  },
  dangerButtonText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
