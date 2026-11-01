import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import AlbumBackground from "../components/AlbumBackground";
import { useAuth } from "../contexts/AuthContext";
import {
  BIO_MAX,
  getMyCreatorProfile,
  normaliseHandle,
  saveMyCreatorProfile,
  validateBio,
  validateDisplayName,
  validateHandle,
} from "../utils/creator";

// Create or edit the signed-in user's public marketplace profile.
// The bio is required: it's what tells buyers who they're buying from.
export default function CreatorSetup() {
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user?.id;

  const [loading, setLoading] = useState(true);
  const [isEdit, setIsEdit] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [bio, setBio] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    getMyCreatorProfile(userId)
      .then((p) => {
        if (cancelled || !p) return;
        setIsEdit(true);
        setDisplayName(p.displayName);
        setHandle(p.handle);
        setBio(p.bio);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function save() {
    if (!userId || saving) return;
    const message =
      validateDisplayName(displayName) ||
      validateHandle(handle) ||
      validateBio(bio);
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const profile = await saveMyCreatorProfile(userId, {
        handle,
        displayName,
        bio,
      });
      router.replace(`/creator/${profile.handle}` as any);
    } catch (e: any) {
      setError(e?.message ?? "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#111" />
      </View>
    );
  }

  return (
    <AlbumBackground style={{ flex: 1 }}>
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <Text style={styles.title}>
            {isEdit ? "Edit your marketplace profile" : "Set up your marketplace profile"}
          </Text>
          <Text style={styles.sub}>
            This is public. Buyers see it on your page and next to your collections.
          </Text>

          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="e.g. Amina Wanjiru"
            maxLength={60}
          />

          <Text style={styles.label}>Handle</Text>
          <TextInput
            style={styles.input}
            value={handle}
            onChangeText={(t) => setHandle(normaliseHandle(t))}
            placeholder="e.g. amina-photo"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={30}
          />
          <Text style={styles.hint}>
            Your page: marketplace.mems-app.com/creator/{handle || "your-handle"}
          </Text>

          <Text style={styles.label}>Bio</Text>
          <TextInput
            style={[styles.input, styles.bio]}
            value={bio}
            onChangeText={setBio}
            placeholder="What do you shoot? What are you about?"
            multiline
            maxLength={BIO_MAX}
          />
          <Text style={styles.hint}>
            {bio.trim().length}/{BIO_MAX} (at least 20)
          </Text>

          {error && <Text style={styles.error}>{error}</Text>}

          <TouchableOpacity style={styles.primary} onPress={save} disabled={saving}>
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryText}>
                {isEdit ? "Save changes" : "Create marketplace account"}
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondary}
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          >
            <Text style={styles.secondaryText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
    </AlbumBackground>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 2,
    padding: 24,
    width: "100%",
    maxWidth: 480,
    gap: 6,
  },
  title: { fontFamily: "Caveat_700Bold", fontSize: 32, lineHeight: 36, color: "#222" },
  sub: { fontSize: 14, color: "#666", marginBottom: 10 },
  label: { fontSize: 13, fontWeight: "600", color: "#111", marginTop: 10 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#111",
  },
  bio: { minHeight: 110, textAlignVertical: "top" },
  hint: { fontSize: 12, color: "#888" },
  error: { color: "#c0392b", fontSize: 14, marginTop: 8 },
  primary: {
    backgroundColor: "#111",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 16,
  },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  secondary: { paddingVertical: 12, alignItems: "center" },
  secondaryText: { color: "#666", fontSize: 15 },
});
