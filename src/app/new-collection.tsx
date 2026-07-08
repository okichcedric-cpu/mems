import PaywallModal from "@/components/PaywallModal";
import UploadProgressOverlay from "@/components/UploadProgressOverlay";
import { useAuth } from "@/contexts/AuthContext";
import { uploadToS3 } from "@/utils/s3";
import { checkSubscription, SubscriptionStatus } from "@/utils/subscription";
import { supabase } from "@/utils/supabase";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const SCREEN_WIDTH = Dimensions.get("window").width;
const IS_WEB = Platform.OS === "web";

// ── Slim indeterminate progress bar ─────────────────────────
// Shown while the browser/OS is reading the selected image files —
// there's no known total at this stage (we don't know how many/how
// large until the picker resolves), so a sliding indeterminate bar
// communicates "something is happening" without a misleading count.
function IndeterminateBar() {
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(slide, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(slide, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const translateX = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [-120, SCREEN_WIDTH],
  });

  return (
    <View style={styles.indeterminateTrack}>
      <Animated.View
        style={[styles.indeterminateFill, { transform: [{ translateX }] }]}
      />
    </View>
  );
}

export default function NewCollectionPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();

  const [collectionName, setCollectionName] = useState("");
  const [selectedAssets, setSelectedAssets] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);
  const [pickingPhotos, setPickingPhotos] = useState(false);
  const [creating, setCreating] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({
    total: 0,
    completed: 0,
  });
  const [subscriptionStatus, setSubscriptionStatus] =
    useState<SubscriptionStatus | null>(null);
  const [existingNames, setExistingNames] = useState<string[]>([]);
  const [existingCount, setExistingCount] = useState(0);
  const [showPaywall, setShowPaywall] = useState(false);
  const [paywallReason, setPaywallReason] = useState<"collections" | "photos">(
    "collections",
  );
  const pendingActionRef = useRef<(() => void) | null>(null);

  const nameInputRef = useRef<TextInput>(null);

  // Load subscription status + existing collection names (for the
  // uniqueness and count-limit checks) once the screen mounts
  useEffect(() => {
    if (!session) return;
    checkSubscription().then(setSubscriptionStatus);
    supabase.functions
      .invoke("list-collections", { body: { userId: session.user.id } })
      .then(({ data }) => {
        const names: string[] = data?.collections ?? [];
        setExistingNames(names);
        setExistingCount(names.length);
      })
      .catch(() => {});
  }, [session]);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }

  async function pickPhotos() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission needed",
        "Please allow access to your photo library.",
      );
      return;
    }

    const maxPhotos = subscriptionStatus?.limits?.maxPhotosPerCollection ?? 10;
    const isLimited = !subscriptionStatus?.isActive;

    setPickingPhotos(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 0.8,
        selectionLimit: isLimited ? maxPhotos : 0,
      });

      if (!result.canceled) {
        setSelectedAssets(result.assets.slice(0, maxPhotos));
        if (isLimited && result.assets.length >= maxPhotos) {
          pendingActionRef.current = createCollection;
          setPaywallReason("photos");
          setShowPaywall(true);
        }
      }
    } finally {
      setPickingPhotos(false);
    }
  }

  async function createCollection() {
    if (!collectionName.trim()) {
      Alert.alert("Name required", "Please enter a name for the collection.");
      return;
    }
    if (selectedAssets.length === 0) {
      Alert.alert("Photos required", "Please select at least one photo.");
      return;
    }
    if (!session) return;

    const maxCollections = subscriptionStatus?.limits?.maxCollections ?? 3;
    const isActive = subscriptionStatus?.isActive ?? false;

    if (existingCount >= maxCollections) {
      if (isActive) {
        Alert.alert(
          "Collection limit reached",
          `Your ${subscriptionStatus?.limits?.label ?? "current"} plan allows up to ${maxCollections} collections. Delete one to make room or upgrade your plan.`,
          [
            { text: "OK", style: "cancel" },
            { text: "View Plans", onPress: () => router.push("/subscription") },
          ],
        );
      } else {
        pendingActionRef.current = createCollection;
        setPaywallReason("collections");
        setShowPaywall(true);
      }
      return;
    }

    const maxPhotos = subscriptionStatus?.limits?.maxPhotosPerCollection ?? 10;
    if (!isActive && selectedAssets.length > maxPhotos) {
      pendingActionRef.current = createCollection;
      setPaywallReason("photos");
      setShowPaywall(true);
      return;
    }

    if (
      existingNames.some(
        (n) => n.toLowerCase() === collectionName.trim().toLowerCase(),
      )
    ) {
      Alert.alert("Name taken", "A collection with this name already exists.");
      return;
    }

    setCreating(true);
    setUploadProgress({ total: selectedAssets.length, completed: 0 });
    try {
      await Promise.all(
        selectedAssets.map(async (asset) => {
          const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
          await uploadToS3(
            session.user.id,
            collectionName.trim(),
            fileName,
            asset.uri,
            asset.width,
            asset.height,
          );
          setUploadProgress((prev) => ({
            ...prev,
            completed: prev.completed + 1,
          }));
        }),
      );
      // Success — go back to the home screen, which refetches on focus
      goBack();
    } catch (error: any) {
      console.error("Create collection error:", error.message);
      Alert.alert("Error", "Something went wrong. Please try again.");
    } finally {
      setCreating(false);
      setUploadProgress({ total: 0, completed: 0 });
    }
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View
        style={[styles.header, { paddingTop: IS_WEB ? 16 : insets.top + 6 }]}
      >
        <TouchableOpacity
          onPress={goBack}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>New Collection</Text>
        <View style={{ width: 22 }} />
      </View>

      {/* Full page scroll — this is the actual fix. A normal scrollable
          page lets the mobile browser's native behaviour keep the
          focused input above the on-screen keyboard, which a fixed
          bottom sheet cannot reliably guarantee — KeyboardAvoidingView
          is a React Native primitive that doesn't hook into a real
          browser's visual viewport resize the way it does on native
          iOS/Android, so it was effectively a no-op on mobile web. */}
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.label}>Collection name</Text>
        <TextInput
          ref={nameInputRef}
          style={styles.input}
          placeholder="e.g. Summer Trip 2026"
          placeholderTextColor="#999"
          value={collectionName}
          onChangeText={setCollectionName}
          autoFocus
          returnKeyType="done"
        />

        <Text style={styles.label}>Photos</Text>
        <TouchableOpacity
          style={styles.photoPickerButton}
          onPress={pickPhotos}
          disabled={pickingPhotos}
        >
          {pickingPhotos ? (
            <View style={styles.pickingRow}>
              <ActivityIndicator size="small" color="#555" />
              <Text style={styles.photoPickerText}>Loading your photos…</Text>
            </View>
          ) : (
            <Text style={styles.photoPickerText}>
              {selectedAssets.length > 0
                ? `${selectedAssets.length} photo${selectedAssets.length !== 1 ? "s" : ""} selected`
                : "📷  Select Photos"}
            </Text>
          )}
        </TouchableOpacity>

        {/* Progress bar while the picker is reading/decoding files */}
        {pickingPhotos && <IndeterminateBar />}

        {selectedAssets.length > 0 && !pickingPhotos && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.previewStrip}
          >
            {selectedAssets.map((asset, i) => (
              <Image
                key={i}
                source={{ uri: asset.uri }}
                style={styles.previewThumb}
                contentFit="cover"
              />
            ))}
          </ScrollView>
        )}

        <View style={styles.actions}>
          <TouchableOpacity style={styles.cancelButton} onPress={goBack}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.createButton, creating && { opacity: 0.6 }]}
            onPress={createCollection}
            disabled={creating}
          >
            {creating ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.createButtonText}>Create</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>

      <PaywallModal
        visible={showPaywall}
        reason={paywallReason}
        currentLimit={
          paywallReason === "collections"
            ? (subscriptionStatus?.limits?.maxCollections ?? 3)
            : (subscriptionStatus?.limits?.maxPhotosPerCollection ?? 10)
        }
        currentTier={
          subscriptionStatus?.isActive
            ? (subscriptionStatus.tier as any)
            : "free"
        }
        onSubscribed={async (_tier) => {
          const status = await checkSubscription();
          setSubscriptionStatus(status);
          setShowPaywall(false);
          if (pendingActionRef.current) {
            const action = pendingActionRef.current;
            pendingActionRef.current = null;
            setTimeout(() => action(), 300);
          }
        }}
        onDismiss={() => {
          setShowPaywall(false);
          pendingActionRef.current = null;
        }}
      />

      <UploadProgressOverlay
        visible={creating}
        total={uploadProgress.total}
        completed={uploadProgress.completed}
        label="Creating your collection"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: "#111" },

  scrollContent: { padding: 20, paddingBottom: 60 },

  label: {
    fontSize: 12,
    fontWeight: "700",
    color: "#999",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 20,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: "#111",
  },
  photoPickerButton: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    borderStyle: "dashed",
    padding: 16,
    alignItems: "center",
  },
  pickingRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  photoPickerText: { fontSize: 15, color: "#555", fontWeight: "500" },

  indeterminateTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: "#eee",
    overflow: "hidden",
    marginTop: 10,
  },
  indeterminateFill: {
    width: 100,
    height: "100%",
    borderRadius: 2,
    backgroundColor: "#4AE8A0",
  },

  previewStrip: { marginTop: 14 },
  previewThumb: {
    width: 80,
    height: 80,
    borderRadius: 10,
    marginRight: 8,
    backgroundColor: "#eee",
  },

  actions: { flexDirection: "row", gap: 12, marginTop: 32 },
  cancelButton: {
    flex: 1,
    paddingVertical: 15,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ddd",
    alignItems: "center",
  },
  cancelButtonText: { fontSize: 15, color: "#555", fontWeight: "500" },
  createButton: {
    flex: 1,
    paddingVertical: 15,
    borderRadius: 12,
    backgroundColor: "#111",
    alignItems: "center",
  },
  createButtonText: { fontSize: 15, color: "#fff", fontWeight: "600" },
});
