import PaywallModal from "@/components/PaywallModal";
import ShimmerPlaceholder from "@/components/ShimmerPlaceholder";
import { Ionicons } from "@expo/vector-icons";
import { Session } from "@supabase/supabase-js";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Modal,
  Platform,
  RefreshControl,
  Image as RNImage,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  deleteCollection,
  getCollectionPreviewUrls,
  listCollections,
  listPhotos,
  uploadToS3,
} from "../utils/s3";
import { getSharedCollections } from "../utils/sharing";
import { checkSubscription, SubscriptionStatus } from "../utils/subscription";
import { supabase } from "../utils/supabase";

const SCREEN_WIDTH = Dimensions.get("window").width;
const COLUMN_WIDTH = (SCREEN_WIDTH - 48) / 2;

type Collection = {
  name: string;
  previewUrls: string[];
  photoCount: number;
  ownerId: string;
  ownerEmail?: string;
  isShared?: boolean;
};

const LEFT_HEIGHTS = [1.35, 1.0, 1.2, 1.0, 1.35, 1.1];
const RIGHT_HEIGHTS = [1.0, 1.35, 1.0, 1.2, 1.1, 1.35];

export default function CollectionsPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [collectionName, setCollectionName] = useState("");
  const [selectedAssets, setSelectedAssets] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);
  const [creating, setCreating] = useState(false);
  const [subscriptionStatus, setSubscriptionStatus] =
    useState<SubscriptionStatus | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [paywallReason, setPaywallReason] = useState<
    "collections" | "photos" | "renewal"
  >("collections");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) {
        fetchCollections(session);
        checkSubscription().then((status) => {
          setSubscriptionStatus(status);
          // Show renewal prompt if subscription recently expired
          if (
            !status.isSubscribed &&
            status.wasSubscribed &&
            status.expiresAt
          ) {
            const expiredAt = new Date(status.expiresAt);
            const now = new Date();
            const daysSinceExpiry =
              (now.getTime() - expiredAt.getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceExpiry < 30) {
              setPaywallReason("renewal");
              setShowPaywall(true);
            }
          }
        });
      } else {
        setLoading(false);
      }
    });
  }, []);

  async function fetchCollections(currentSession: Session) {
    try {
      // Step 1 — fetch owned collections
      let ownedCollections: Collection[] = [];
      const names = await listCollections(currentSession.user.id);

      if (names.length > 0) {
        const ownedData = await Promise.allSettled(
          names.map(async (name: string) => {
            const [previewUrls, photos] = await Promise.all([
              getCollectionPreviewUrls(currentSession.user.id, name),
              listPhotos(currentSession.user.id, name),
            ]);
            const realPhotos = photos.filter(
              (p: any) => p.Key && !p.Key.includes("/thumbs/"),
            );
            return {
              name,
              previewUrls,
              photoCount: realPhotos.length,
              ownerId: currentSession.user.id,
              isShared: false,
            };
          }),
        );
        ownedCollections = ownedData
          .filter(
            (r): r is PromiseFulfilledResult<Collection> =>
              r.status === "fulfilled",
          )
          .map((r) => r.value);
      }

      // Step 2 — fetch shared collections completely separately
      let sharedCollections: Collection[] = [];
      const userEmail = currentSession.user.email ?? "";
      const shared = await getSharedCollections(userEmail);

      for (const { ownerId, ownerEmail, collectionName } of shared) {
        try {
          const photos = await listPhotos(ownerId, collectionName);
          const realPhotos = photos.filter(
            (p: any) => p.Key && !p.Key.includes("/thumbs/"),
          );

          // Skip empty collections — owner likely deleted them
          if (realPhotos.length === 0) {
            await supabase
              .from("shared_collections")
              .delete()
              .eq("owner_id", ownerId)
              .eq("collection_name", collectionName);
            continue;
          }

          const previewUrls = await getCollectionPreviewUrls(
            ownerId,
            collectionName,
          );
          sharedCollections.push({
            name: collectionName,
            previewUrls,
            photoCount: realPhotos.length,
            ownerId,
            ownerEmail,
            isShared: true,
          });
        } catch {
          // Collection no longer accessible — skip it
        }
      }

      setCollections([...ownedCollections, ...sharedCollections]);
    } catch (error: any) {
      Alert.alert("Error", error.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    if (session) fetchCollections(session);
  }, [session]);

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
    const isLimited = !subscriptionStatus?.isSubscribed;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 0.8,
      selectionLimit: isLimited ? maxPhotos : 0,
    });

    if (!result.canceled) {
      setSelectedAssets(result.assets.slice(0, maxPhotos));

      // Show message if they hit the limit
      if (isLimited && result.assets.length >= maxPhotos) {
        setTimeout(() => {
          if (Platform.OS === "web") {
            const upgrade = window.confirm(
              `Free accounts can only upload ${maxPhotos} photos per collection.\n\nOnly the first ${maxPhotos} photos have been selected.\n\nWould you like to subscribe for unlimited uploads?`,
            );
            if (upgrade) {
              setShowNewCollection(false);
              setPaywallReason("photos");
              setShowPaywall(true);
            }
          } else {
            Alert.alert(
              `${maxPhotos} Photo Limit Reached`,
              `Free accounts can only upload ${maxPhotos} photos per collection. Only the first ${maxPhotos} photos have been selected.`,
              [
                { text: "Continue with selection", style: "cancel" },
                {
                  text: "Subscribe for unlimited",
                  onPress: () => {
                    setShowNewCollection(false);
                    setPaywallReason("photos");
                    setShowPaywall(true);
                  },
                },
              ],
            );
          }
        }, 500);
      }
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

    // Check collection limit for free users
    const ownedCollections = collections.filter((c) => !c.isShared);
    if (
      !subscriptionStatus?.isSubscribed &&
      ownedCollections.length >=
        (subscriptionStatus?.limits?.maxCollections ?? 3)
    ) {
      setShowNewCollection(false);
      setPaywallReason(
        subscriptionStatus?.wasSubscribed ? "renewal" : "collections",
      );
      setShowPaywall(true);
      return;
    }

    // Check photo limit for free users
    const maxPhotos = subscriptionStatus?.limits?.maxPhotosPerCollection ?? 10;
    if (
      !subscriptionStatus?.isSubscribed &&
      selectedAssets.length > maxPhotos
    ) {
      Alert.alert(
        "Too many photos",
        `Free accounts can add up to ${maxPhotos} photos per collection. Please select fewer photos or subscribe for unlimited uploads.`,
        [
          { text: "Reduce Photos", style: "cancel" },
          {
            text: "Subscribe",
            onPress: () => {
              setShowNewCollection(false);
              setPaywallReason(
                subscriptionStatus?.wasSubscribed ? "renewal" : "photos",
              );
              setShowPaywall(true);
            },
          },
        ],
      );
      return;
    }

    if (
      collections.some(
        (c) => c.name.toLowerCase() === collectionName.trim().toLowerCase(),
      )
    ) {
      Alert.alert("Name taken", "A collection with this name already exists.");
      return;
    }

    setCreating(true);
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
        }),
      );
      setShowNewCollection(false);
      setCollectionName("");
      setSelectedAssets([]);
      await fetchCollections(session);
    } catch (error: any) {
      Alert.alert("Error", error.message);
    } finally {
      setCreating(false);
    }
  }

  function confirmDeleteCollection(collection: Collection) {
    Alert.alert(
      "Delete Collection",
      `Are you sure you want to delete "${collection.name}" and all its photos?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            if (!session) return;
            try {
              await deleteCollection(session.user.id, collection.name);
              await fetchCollections(session);
            } catch (error: any) {
              Alert.alert("Error", error.message);
            }
          },
        },
      ],
    );
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  const CollectionCollage = ({
    urls,
    name,
  }: {
    urls: string[];
    name: string;
  }) => (
    <View style={StyleSheet.absoluteFill}>
      <View style={styles.collageContainer}>
        {/* Left — one tall image */}
        <View style={styles.collageLeft}>
          {urls[0] ? (
            <View style={StyleSheet.absoluteFill}>
              <ShimmerPlaceholder />
              <Image
                source={{ uri: urls[0] }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                cachePolicy="memory-disk"
                recyclingKey={urls[0]}
                transition={{ duration: 300, effect: "cross-dissolve" }}
                pointerEvents="none"
              />
            </View>
          ) : (
            <ShimmerPlaceholder />
          )}
        </View>

        {/* Right — two stacked images */}
        <View style={styles.collageRight}>
          <View style={styles.collageRightTop}>
            {urls[1] ? (
              <View style={StyleSheet.absoluteFill}>
                <ShimmerPlaceholder />
                <Image
                  source={{ uri: urls[1] }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  recyclingKey={urls[1]}
                  transition={{ duration: 300, effect: "cross-dissolve" }}
                  pointerEvents="none"
                />
              </View>
            ) : (
              <ShimmerPlaceholder />
            )}
          </View>
          <View style={styles.collageRightBottom}>
            {urls[2] ? (
              <View style={StyleSheet.absoluteFill}>
                <ShimmerPlaceholder />
                <Image
                  source={{ uri: urls[2] }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  recyclingKey={urls[2]}
                  transition={{ duration: 300, effect: "cross-dissolve" }}
                  pointerEvents="none"
                />
              </View>
            ) : (
              <ShimmerPlaceholder />
            )}
          </View>
        </View>
      </View>

      {/* Name overlay */}
      <View style={styles.collageOverlay}>
        <Text style={styles.collageName} numberOfLines={1}>
          {name}
        </Text>
      </View>
    </View>
  );

  const leftCollections = collections.filter((_, i) => i % 2 === 0);
  const rightCollections = collections.filter((_, i) => i % 2 !== 0);

  const renderCard = (
    collection: Collection,
    index: number,
    heightRatios: number[],
  ) => {
    const cardHeight = COLUMN_WIDTH * heightRatios[index % heightRatios.length];
    return (
      <TouchableOpacity
        key={`${collection.ownerId}-${collection.name}`}
        style={[styles.collectionCard, { height: cardHeight }]}
        onPress={() =>
          router.push(
            `/collection/${encodeURIComponent(collection.name)}?ownerId=${collection.ownerId}`,
          )
        }
        onLongPress={() =>
          !collection.isShared && confirmDeleteCollection(collection)
        }
        activeOpacity={0.85}
      >
        <CollectionCollage
          urls={collection.previewUrls}
          name={collection.name}
        />

        {/* Shared badge */}
        {collection.isShared && (
          <View style={styles.sharedBadge}>
            <Text style={styles.sharedBadgeText}>Shared with you</Text>
          </View>
        )}

        {/* Delete button — only for owned collections */}
        {!collection.isShared && (
          <TouchableOpacity
            style={styles.deleteCardButton}
            onPress={(e) => {
              e.stopPropagation();
              confirmDeleteCollection(collection);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.deleteCardButtonText}>✕</Text>
          </TouchableOpacity>
        )}

        <View style={styles.collectionMeta}>
          <Text style={styles.photoCount}>
            {collection.photoCount} photo
            {collection.photoCount !== 1 ? "s" : ""}
            {collection.isShared ? ` · ${collection.ownerEmail}` : ""}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        {/* Left actions */}
        <View style={styles.headerLeft}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => router.replace("/")}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="home-outline" size={22} color="#111" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.tierButton}
            onPress={() => router.push("/subscription")}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={subscriptionStatus?.isActive ? "star" : "star-outline"}
              size={16}
              color={subscriptionStatus?.isActive ? "#4AE8A0" : "#888"}
            />
            <Text
              style={[
                styles.tierLabel,
                subscriptionStatus?.isActive && { color: "#4AE8A0" },
              ]}
            >
              {subscriptionStatus?.isActive
                ? `${subscriptionStatus.limits?.label ?? "Pro"}`
                : "Free"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Centered logo */}
        <TouchableOpacity
          style={styles.headerCenter}
          onPress={() => router.replace("/")}
        >
          <RNImage
            source={require("@/assets/images/icon.png")}
            style={styles.headerLogo}
            resizeMode="contain"
          />
        </TouchableOpacity>

        {/* Right actions */}
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => setShowNewCollection(true)}
          >
            <Ionicons name="add-circle-outline" size={24} color="#111" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconButton} onPress={signOut}>
            <Ionicons name="log-out-outline" size={22} color="#111" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Collections Grid */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#000" />
        </View>
      ) : collections.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>🗂️</Text>
          <Text style={styles.emptyTitle}>No collections yet</Text>
          <Text style={styles.emptyText}>
            Tap + New to create your first collection
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.grid}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          <View style={styles.columns}>
            <View style={styles.column}>
              {leftCollections.map((collection, index) =>
                renderCard(collection, index, LEFT_HEIGHTS),
              )}
            </View>
            <View style={styles.column}>
              {rightCollections.map((collection, index) =>
                renderCard(collection, index, RIGHT_HEIGHTS),
              )}
            </View>
          </View>
        </ScrollView>
      )}

      {/* New Collection Modal */}
      <Modal
        visible={showNewCollection}
        transparent
        animationType="slide"
        statusBarTranslucent
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New Collection</Text>
            <TextInput
              style={styles.input}
              placeholder="Collection name"
              placeholderTextColor="#999"
              value={collectionName}
              onChangeText={setCollectionName}
              autoFocus
            />
            <TouchableOpacity
              style={styles.photoPickerButton}
              onPress={pickPhotos}
            >
              <Text style={styles.photoPickerText}>
                {selectedAssets.length > 0
                  ? `${selectedAssets.length} photo${selectedAssets.length !== 1 ? "s" : ""} selected`
                  : "📷  Select Photos"}
              </Text>
            </TouchableOpacity>
            {selectedAssets.length > 0 && (
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
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => {
                  setShowNewCollection(false);
                  setCollectionName("");
                  setSelectedAssets([]);
                }}
              >
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
          </View>
        </View>
      </Modal>

      {/* Paywall Modal */}
      <PaywallModal
        visible={showPaywall}
        reason={paywallReason}
        onClose={() => setShowPaywall(false)}
        onSubscribed={async () => {
          const status = await checkSubscription();
          setSubscriptionStatus(status);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f5f5f5" },

  // ── Header ────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: Platform.OS === "web" ? 16 : 56,
    paddingBottom: 12,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    minHeight: Platform.OS === "web" ? 64 : 100,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flex: 1,
  },
  headerCenter: {
    alignItems: "center",
    justifyContent: "center",
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flex: 1,
    justifyContent: "flex-end",
  },
  headerLogo: {
    height: Platform.OS === "web" ? 40 : SCREEN_WIDTH * 0.12,
    width: Platform.OS === "web" ? 40 : SCREEN_WIDTH * 0.12,
    resizeMode: "contain",
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  tierButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "#f5f5f5",
    borderWidth: 1,
    borderColor: "#eee",
  },
  tierLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#888",
    letterSpacing: 0.2,
  },
  subtitle: {
    fontSize: Math.min(12, SCREEN_WIDTH * 0.031),
    color: "#999",
    marginTop: 2,
  },
  subscriptionBadge: {
    fontSize: 10,
    color: "#4AE8A0",
    fontWeight: "600",
    marginTop: 2,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  newButton: {
    backgroundColor: "#111",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  newButtonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: Math.min(13, SCREEN_WIDTH * 0.034),
  },
  signOutButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#ddd",
  },
  signOutText: {
    fontSize: Math.min(13, SCREEN_WIDTH * 0.034),
    color: "#666",
  },

  // ── Grid ─────────────────────────────────────────────────
  grid: {
    padding: 16,
    paddingBottom: 36,
  },
  columns: {
    flexDirection: "row",
    gap: 16,
  },
  column: {
    flex: 1,
    gap: 16,
  },

  // ── Collection card ───────────────────────────────────────
  collectionCard: {
    width: "100%",
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e0e0e0",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 5,
  },
  collectionMeta: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
  },
  photoCount: {
    fontSize: 11,
    color: "rgba(255,255,255,0.8)",
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  deleteCardButton: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  deleteCardButtonText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 14,
  },

  // ── Collage ───────────────────────────────────────────────
  collageContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: 3,
  },
  collageLeft: {
    flex: 1.1,
    position: "relative",
  },
  collageRight: {
    flex: 0.9,
    gap: 3,
  },
  collageRightTop: {
    flex: 1.2,
    position: "relative",
  },
  collageRightBottom: {
    flex: 0.8,
    position: "relative",
  },
  collageEmpty: {
    flex: 1,
    backgroundColor: "#e8e8e8",
  },
  collageOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 8,
    paddingVertical: 20,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  collageName: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 13,
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  sharedBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    backgroundColor: "rgba(0,100,255,0.75)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    zIndex: 10,
  },
  sharedBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },

  // ── Empty / loading ───────────────────────────────────────
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
  },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 18, fontWeight: "600", color: "#333" },
  emptyText: { fontSize: 14, color: "#999" },

  // ── Modal ─────────────────────────────────────────────────
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#111",
    marginBottom: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: "#111",
    marginBottom: 12,
  },
  photoPickerButton: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    borderStyle: "dashed",
    padding: 16,
    alignItems: "center",
    marginBottom: 12,
  },
  photoPickerText: { fontSize: 15, color: "#555", fontWeight: "500" },
  previewStrip: { marginBottom: 16 },
  previewThumb: {
    width: 72,
    height: 72,
    borderRadius: 8,
    marginRight: 8,
    backgroundColor: "#eee",
  },
  modalActions: { flexDirection: "row", gap: 12, marginTop: 8 },
  cancelButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ddd",
    alignItems: "center",
  },
  cancelButtonText: { fontSize: 15, color: "#555", fontWeight: "500" },
  createButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: "#111",
    alignItems: "center",
  },
  createButtonText: { fontSize: 15, color: "#fff", fontWeight: "600" },
});
