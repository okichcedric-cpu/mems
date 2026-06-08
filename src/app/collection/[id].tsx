import { Session } from "@supabase/supabase-js";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Modal,
  PanResponder,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import PaywallModal from "../../components/PaywallModal";
import {
  deleteCollection,
  deleteFromS3,
  getPhotoMetadata,
  getSignedPhotoUrl,
  listPhotos,
  uploadToS3,
} from "../../utils/s3";
import {
  getCollectionShares,
  shareCollection,
  unshareCollection,
} from "../../utils/sharing";
import { checkSubscription } from "../../utils/subscription";
import { supabase } from "../../utils/supabase";

const SCREEN_WIDTH = Dimensions.get("window").width;
const SCREEN_HEIGHT = Dimensions.get("window").height;
const COLUMN_WIDTH = (SCREEN_WIDTH - 32) / 2;

type Photo = {
  key: string;
  url: string;
  width: number;
  height: number;
};

export default function CollectionPage() {
  const { id, ownerId: ownerIdParam } = useLocalSearchParams<{
    id: string;
    ownerId?: string;
  }>();
  const collectionName = decodeURIComponent(id);
  const router = useRouter();

  const [session, setSession] = useState<Session | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareEmail, setShareEmail] = useState("");
  const [sharing, setSharing] = useState(false);
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [effectiveOwnerId, setEffectiveOwnerId] = useState<string | null>(null);
  const isOwner = session?.user?.id === (effectiveOwnerId ?? session?.user?.id);
  const [subscriptionStatus, setSubscriptionStatus] =
    useState<SubscriptionStatus | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(
    null,
  );
  const swipeX = new Animated.Value(0);

  const leftColumn = photos.filter((_, i) => i % 2 === 0);
  const rightColumn = photos.filter((_, i) => i % 2 !== 0);

  // Deterministic colour per email
  function getAvatarColor(email: string): string {
    const colors = [
      "#E8704A",
      "#4A90E8",
      "#7B4AE8",
      "#4AE8A0",
      "#E84A7B",
      "#E8C84A",
      "#4AE8D8",
      "#A04AE8",
    ];
    let hash = 0;
    for (let i = 0; i < email.length; i++) {
      hash = email.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) {
        const owner = ownerIdParam ?? session.user.id;
        setEffectiveOwnerId(owner);
        fetchPhotos(session, owner);
        loadShares();
        // In useEffect
        checkSubscription().then((status) => {
          setSubscriptionStatus(status);
        });
      } else {
        setLoading(false);
      }
    });
  }, []);

  async function fetchPhotos(currentSession: Session, ownerId?: string) {
    const isOwner =
      session?.user?.id === (effectiveOwnerId ?? session?.user?.id);
    try {
      const objects = await listPhotos(owner, collectionName);
      const validObjects = objects.filter(
        (obj) => obj.Key && !obj.Key.includes("/thumbs/"),
      );
      if (validObjects.length === 0) {
        setPhotos([]);
        return;
      }

      const photosWithUrls = await Promise.allSettled(
        validObjects.map(async (obj) => {
          const url = await getSignedPhotoUrl(obj.Key!);
          let width = 1,
            height = 1;
          try {
            const dimensions = await getPhotoMetadata(obj.Key!);
            width = dimensions.width || 1;
            height = dimensions.height || 1;
          } catch {}
          return { key: obj.Key!, url, width, height };
        }),
      );

      const successful = photosWithUrls
        .filter(
          (r): r is PromiseFulfilledResult<Photo> => r.status === "fulfilled",
        )
        .map((r) => r.value);
      setPhotos(successful);
    } catch (error: any) {
      Alert.alert("Error", error.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    if (session) fetchPhotos(session);
  }, [session]);

  // Helper to open photo at index
  function openPhoto(index: number) {
    setSelectedPhotoIndex(index);
  }

  // Navigate to next/previous photo
  function goToNext() {
    if (selectedPhotoIndex === null) return;
    const next = selectedPhotoIndex + 1;
    if (next < photos.length) setSelectedPhotoIndex(next);
  }

  function goToPrev() {
    if (selectedPhotoIndex === null) return;
    const prev = selectedPhotoIndex - 1;
    if (prev >= 0) setSelectedPhotoIndex(prev);
  }

  // Swipe handler for mobile
  const panResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 10,
    onPanResponderMove: (_, gs) => {
      swipeX.setValue(gs.dx);
    },
    onPanResponderRelease: (_, gs) => {
      if (gs.dx < -80) {
        goToNext();
      } else if (gs.dx > 80) {
        goToPrev();
      }
      Animated.spring(swipeX, { toValue: 0, useNativeDriver: true }).start();
    },
  });

  async function uploadPhoto() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission needed",
        "Please allow access to your photo library.",
      );
      return;
    }

    // Check photo limit
    let subStatus = subscriptionStatus;
    if (!subStatus) {
      subStatus = await checkSubscription();
      setSubscriptionStatus(subStatus);
    }

    const realPhotos = photos.filter((p) => !p.key.includes("/thumbs/"));
    const maxPhotos = subStatus?.limits?.maxPhotosPerCollection ?? 10;
    if (!subStatus?.isSubscribed && realPhotos.length >= maxPhotos) {
      setShowPaywall(true);
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 0.8,
    });

    if (result.canceled || !session) return;
    setUploading(true);
    try {
      // Use effectiveOwnerId so photos go into the owner's folder
      const uploadOwnerId = effectiveOwnerId ?? session.user.id;
      await Promise.all(
        result.assets.map(async (asset) => {
          const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
          await uploadToS3(
            uploadOwnerId,
            collectionName,
            fileName,
            asset.uri,
            asset.width,
            asset.height,
          );
        }),
      );
      await fetchPhotos(session);
    } catch (error: any) {
      Alert.alert("Upload failed", error.message);
    } finally {
      setUploading(false);
    }
  }

  async function deletePhoto(photo: Photo) {
    const confirmed =
      Platform.OS === "web"
        ? window.confirm("Are you sure you want to delete this photo?")
        : await new Promise<boolean>((resolve) => {
            Alert.alert(
              "Delete Photo",
              "Are you sure you want to delete this photo?",
              [
                {
                  text: "Cancel",
                  style: "cancel",
                  onPress: () => resolve(false),
                },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: () => resolve(true),
                },
              ],
            );
          });

    if (!confirmed) return;

    try {
      setSelectedPhoto(null);
      setPhotos((prev) => prev.filter((p) => p.key !== photo.key));
      await deleteFromS3(photo.key);
      if (session) await fetchPhotos(session);
    } catch (error: any) {
      const msg = `${error.name}: ${error.message}`;
      if (Platform.OS === "web") {
        window.alert("Delete failed: " + msg);
      } else {
        Alert.alert("Delete Failed", msg);
      }
      if (session) await fetchPhotos(session);
    }
  }

  async function handleDeleteCollection() {
    const confirmed =
      Platform.OS === "web"
        ? window.confirm(
            `Are you sure you want to delete "${collectionName}" and all its photos? This cannot be undone.`,
          )
        : await new Promise<boolean>((resolve) => {
            Alert.alert(
              "Delete Collection",
              `Are you sure you want to delete "${collectionName}" and all its photos? This cannot be undone.`,
              [
                {
                  text: "Cancel",
                  style: "cancel",
                  onPress: () => resolve(false),
                },
                {
                  text: "Delete All",
                  style: "destructive",
                  onPress: () => resolve(true),
                },
              ],
            );
          });

    if (!confirmed) return;

    try {
      setLoading(true);
      if (session) await deleteCollection(session.user.id, collectionName);
      router.replace("/");
    } catch (error: any) {
      if (Platform.OS === "web") {
        window.alert("Failed to delete collection: " + error.message);
      } else {
        Alert.alert("Error", error.message);
      }
      setLoading(false);
    }
  }

  async function loadShares() {
    if (!session) return;
    try {
      const emails = await getCollectionShares(session.user.id, collectionName);
      setSharedWith(emails);
    } catch (error: any) {
      console.warn("loadShares error:", error.message);
    }
  }

  async function handleShare() {
    if (!shareEmail.trim()) {
      if (Platform.OS === "web") {
        window.alert("Please enter an email address.");
      } else {
        Alert.alert("Email required", "Please enter an email address.");
      }
      return;
    }
    if (!session?.user?.email) return;
    setSharing(true);
    try {
      await shareCollection(
        session.user.id,
        session.user.email,
        collectionName,
        shareEmail.trim(),
      );
      const email = shareEmail.trim();
      setShareEmail("");
      setShowShareModal(false);
      await loadShares();

      setTimeout(() => {
        if (Platform.OS === "web") {
          window.alert(`Collection shared with ${email} ✓`);
        } else {
          Alert.alert("Shared!", `Collection shared with ${email}`);
        }
      }, 300);
    } catch (error: any) {
      if (Platform.OS === "web") {
        window.alert("Error: " + error.message);
      } else {
        Alert.alert("Error", error.message);
      }
    } finally {
      setSharing(false);
    }
  }

  async function handleUnshare(email: string) {
    const confirmed =
      Platform.OS === "web"
        ? window.confirm(`Remove access for ${email}?`)
        : await new Promise<boolean>((resolve) => {
            Alert.alert("Remove Access", `Remove access for ${email}?`, [
              {
                text: "Cancel",
                style: "cancel",
                onPress: () => resolve(false),
              },
              {
                text: "Remove",
                style: "destructive",
                onPress: () => resolve(true),
              },
            ]);
          });
    if (!confirmed) return;
    try {
      await unshareCollection(session!.user.id, collectionName, email);
      await loadShares();
    } catch (error: any) {
      Alert.alert("Error", error.message);
    }
  }

  const renderPhoto = (item: Photo, index: number) => {
    const hasDimensions = item.width !== 1 || item.height !== 1;
    const fallbackHeights = [160, 220, 180, 260, 140, 200, 240, 170];
    const aspectRatio = hasDimensions ? item.height / item.width : null;
    const height = aspectRatio
      ? COLUMN_WIDTH * aspectRatio
      : fallbackHeights[index % fallbackHeights.length];

    return (
      <TouchableOpacity
        key={item.key}
        style={[styles.photoContainer, { height }]}
        onPress={() => openPhoto(photos.indexOf(item))}
        activeOpacity={0.85}
      >
        <View style={styles.photoPlaceholder} />
        <Image
          source={{ uri: item.url }}
          style={[styles.photo, StyleSheet.absoluteFill]}
          contentFit="contain"
          cachePolicy="memory-disk"
          recyclingKey={item.key}
          transition={{ duration: 300, effect: "cross-dissolve" }}
          onLoad={(e) => {
            if (!hasDimensions) {
              const { width, height } = e.source;
              setPhotos((prev) =>
                prev.map((p) =>
                  p.key === item.key ? { ...p, width, height } : p,
                ),
              );
            }
          }}
        />
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.title} numberOfLines={1}>
            {collectionName}
          </Text>
          <Text style={styles.subtitle}>
            {photos.length} photo{photos.length !== 1 ? "s" : ""}
          </Text>
        </View>

        <View style={styles.headerRight}>
          {isOwner && (
            <TouchableOpacity
              style={styles.shareButton}
              onPress={() => {
                loadShares();
                setShowShareModal(true);
              }}
            >
              {sharedWith.length > 0 ? (
                <View style={styles.shareButtonWithAvatars}>
                  <View
                    style={[
                      styles.shareButtonAvatar,
                      { backgroundColor: getAvatarColor(sharedWith[0]) },
                    ]}
                  >
                    <Text style={styles.shareButtonAvatarLetter}>
                      {sharedWith[0][0].toUpperCase()}
                    </Text>
                  </View>
                  {sharedWith.length > 1 && (
                    <Text style={styles.shareButtonCount}>
                      +{sharedWith.length - 1}
                    </Text>
                  )}
                </View>
              ) : (
                <Text style={styles.shareButtonText}>Share</Text>
              )}
            </TouchableOpacity>
          )}

          {/* Upload button — visible to owner AND shared recipients */}
          <TouchableOpacity
            style={styles.uploadButton}
            onPress={uploadPhoto}
            disabled={uploading}
          >
            {uploading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.uploadButtonText}>+ Add</Text>
            )}
          </TouchableOpacity>

          {/* Share and delete — owner only */}
          {isOwner && (
            <>
              <TouchableOpacity
                style={styles.shareButton}
                onPress={() => {
                  loadShares();
                  setShowShareModal(true);
                }}
              >
                {sharedWith.length > 0 ? (
                  <View style={styles.shareButtonWithAvatars}>
                    <View
                      style={[
                        styles.shareButtonAvatar,
                        { backgroundColor: getAvatarColor(sharedWith[0]) },
                      ]}
                    >
                      <Text style={styles.shareButtonAvatarLetter}>
                        {sharedWith[0][0].toUpperCase()}
                      </Text>
                    </View>
                    {sharedWith.length > 1 && (
                      <Text style={styles.shareButtonCount}>
                        +{sharedWith.length - 1}
                      </Text>
                    )}
                  </View>
                ) : (
                  <Text style={styles.shareButtonText}>Share</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.deleteCollectionButton}
                onPress={handleDeleteCollection}
              >
                <Text style={styles.deleteCollectionText}>🗑</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      {/* Avatar strip — shown when collection is shared */}
      {sharedWith.length > 0 && (
        <TouchableOpacity
          style={styles.avatarStrip}
          onPress={() => {
            loadShares();
            setShowShareModal(true);
          }}
          activeOpacity={0.8}
        >
          <View style={styles.avatarRow}>
            {sharedWith.slice(0, 5).map((email, i) => (
              <View
                key={email}
                style={[
                  styles.avatar,
                  { marginLeft: i === 0 ? 0 : -10, zIndex: 10 - i },
                  { backgroundColor: getAvatarColor(email) },
                ]}
              >
                <Text style={styles.avatarLetter}>
                  {email[0].toUpperCase()}
                </Text>
              </View>
            ))}
            {sharedWith.length > 5 && (
              <View
                style={[
                  styles.avatar,
                  { marginLeft: -10, backgroundColor: "#999" },
                ]}
              >
                <Text style={styles.avatarLetter}>
                  +{sharedWith.length - 5}
                </Text>
              </View>
            )}
          </View>
          <Text style={styles.avatarStripLabel}>
            Shared with {sharedWith.length}{" "}
            {sharedWith.length === 1 ? "person" : "people"}
          </Text>
        </TouchableOpacity>
      )}

      {/* Photo Grid */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#000" />
        </View>
      ) : photos.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>📷</Text>
          <Text style={styles.emptyTitle}>No photos yet</Text>
          <Text style={styles.emptyText}>Tap + Add to upload photos</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.grid}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.columns}>
            <View style={styles.column}>
              {leftColumn.map((item, index) => renderPhoto(item, index * 2))}
            </View>
            <View style={styles.column}>
              {rightColumn.map((item, index) =>
                renderPhoto(item, index * 2 + 1),
              )}
            </View>
          </View>
        </ScrollView>
      )}

      {/* Full Screen Photo Viewer */}
      {/* Full Screen Photo Viewer */}
      <Modal
        visible={selectedPhotoIndex !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
      >
        <View style={styles.modalBackdrop}>
          {/* Close button */}
          <TouchableOpacity
            style={styles.modalClose}
            onPress={() => setSelectedPhotoIndex(null)}
            hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
          >
            <Text style={styles.modalCloseText}>✕</Text>
          </TouchableOpacity>

          {/* Photo counter */}
          {selectedPhotoIndex !== null && (
            <Text style={styles.photoCounter}>
              {selectedPhotoIndex + 1} / {photos.length}
            </Text>
          )}

          {/* Image with swipe on mobile */}
          {selectedPhotoIndex !== null &&
            (Platform.OS === "web" ? (
              // Web — show arrows
              <View style={styles.webViewerRow}>
                <TouchableOpacity
                  style={[
                    styles.arrowButton,
                    selectedPhotoIndex === 0 && styles.arrowButtonDisabled,
                  ]}
                  onPress={goToPrev}
                  disabled={selectedPhotoIndex === 0}
                >
                  <Text style={styles.arrowText}>‹</Text>
                </TouchableOpacity>

                <View style={styles.modalCard}>
                  <Image
                    source={{ uri: photos[selectedPhotoIndex].url }}
                    style={styles.modalImage}
                    contentFit="contain"
                  />
                </View>

                <TouchableOpacity
                  style={[
                    styles.arrowButton,
                    selectedPhotoIndex === photos.length - 1 &&
                      styles.arrowButtonDisabled,
                  ]}
                  onPress={goToNext}
                  disabled={selectedPhotoIndex === photos.length - 1}
                >
                  <Text style={styles.arrowText}>›</Text>
                </TouchableOpacity>
              </View>
            ) : (
              // Mobile — swipe gesture
              <Animated.View
                style={[
                  styles.modalCard,
                  { transform: [{ translateX: swipeX }] },
                ]}
                {...panResponder.panHandlers}
              >
                <Image
                  source={{ uri: photos[selectedPhotoIndex].url }}
                  style={styles.modalImage}
                  contentFit="contain"
                />
              </Animated.View>
            ))}

          {/* Swipe hint on mobile */}
          {Platform.OS !== "web" && photos.length > 1 && (
            <Text style={styles.swipeHint}>← swipe to navigate →</Text>
          )}

          {/* Delete button — owner only */}
          {isOwner && selectedPhotoIndex !== null && (
            <TouchableOpacity
              style={styles.deleteButton}
              onPress={() => {
                const photo = photos[selectedPhotoIndex];
                if (photo) deletePhoto(photo);
              }}
            >
              <Text style={styles.deleteButtonText}>🗑 Delete Photo</Text>
            </TouchableOpacity>
          )}
        </View>
      </Modal>

      {/* Share Modal */}
      <Modal
        visible={showShareModal}
        transparent
        animationType="fade"
        statusBarTranslucent
      >
        <TouchableOpacity
          style={styles.shareOverlayBackdrop}
          activeOpacity={1}
          onPress={() => setShowShareModal(false)}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={styles.shareOverlayCard}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.shareModalHeader}>
              <Text style={styles.shareModalTitle}>Share Collection</Text>
              <TouchableOpacity
                onPress={() => setShowShareModal(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.shareModalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.shareInputRow}>
              <TextInput
                style={styles.shareInput}
                placeholder="Enter email to share"
                placeholderTextColor="#999"
                value={shareEmail}
                onChangeText={setShareEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={[styles.shareSubmitButton, sharing && { opacity: 0.6 }]}
                onPress={handleShare}
                disabled={sharing}
              >
                {sharing ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.shareSubmitText}>Send</Text>
                )}
              </TouchableOpacity>
            </View>

            {sharedWith.length > 0 && (
              <View style={styles.shareList}>
                <Text style={styles.shareListTitle}>Shared with</Text>
                {sharedWith.map((email) => (
                  <View key={email} style={styles.shareListRow}>
                    <View
                      style={[
                        styles.shareListAvatar,
                        { backgroundColor: getAvatarColor(email) },
                      ]}
                    >
                      <Text style={styles.shareListAvatarLetter}>
                        {email[0].toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.shareListEmail} numberOfLines={1}>
                      {email}
                    </Text>
                    <TouchableOpacity
                      style={styles.removeButton}
                      onPress={() => handleUnshare(email)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.removeButtonText}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
      {/* Paywall Modal ← ADD HERE */}
      <PaywallModal
        visible={showPaywall}
        reason="photos"
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
  container: { flex: 1, backgroundColor: "#f9f9f9" },

  // ── Header ────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 16,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  backButton: { paddingRight: 8 },
  backText: { fontSize: 15, color: "#111", fontWeight: "500" },
  headerCenter: { flex: 1, alignItems: "center" },
  title: { fontSize: 18, fontWeight: "700", color: "#111" },
  subtitle: { fontSize: 12, color: "#999", marginTop: 2 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  uploadButton: {
    backgroundColor: "#111",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    alignItems: "center",
  },
  uploadButtonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  deleteCollectionButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,60,60,0.12)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,60,60,0.3)",
  },
  deleteCollectionText: { fontSize: 16 },

  // ── Share button ─────────────────────────────────────────
  shareButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#111",
    alignItems: "center",
    justifyContent: "center",
  },
  shareButtonText: { fontSize: 13, color: "#111", fontWeight: "600" },
  shareButtonWithAvatars: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  shareButtonAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  shareButtonAvatarLetter: { color: "#fff", fontSize: 11, fontWeight: "700" },
  shareButtonCount: { fontSize: 12, color: "#111", fontWeight: "600" },

  // ── Avatar strip ─────────────────────────────────────────
  avatarStrip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
    gap: 10,
  },
  avatarRow: { flexDirection: "row", alignItems: "center" },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#fff",
  },
  avatarLetter: { color: "#fff", fontSize: 13, fontWeight: "700" },
  avatarStripLabel: { fontSize: 13, color: "#666", fontWeight: "500" },

  // ── Grid ─────────────────────────────────────────────────
  grid: { padding: 12 },
  columns: { flexDirection: "row", gap: 8 },
  column: { flex: 1, gap: 8 },
  photoContainer: { width: "100%", borderRadius: 12, overflow: "hidden" },
  photo: { width: "100%", height: "100%" },
  photoPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#e8e8e8",
  },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", gap: 8 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 18, fontWeight: "600", color: "#333" },
  emptyText: { fontSize: 14, color: "#999" },

  // ── Photo viewer modal ───────────────────────────────────
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "center",
    alignItems: "center",
    padding: 12,
  },
  modalClose: {
    position: "absolute",
    top: 52,
    right: 24,
    backgroundColor: "rgba(255,255,255,0.2)",
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 20,
  },
  modalCloseText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  modalCard: {
    width: SCREEN_WIDTH - 24,
    height: SCREEN_HEIGHT * 0.72,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#111",
    zIndex: 10,
  },
  modalImage: { width: "100%", height: "100%" },
  deleteButton: {
    marginTop: 16,
    paddingHorizontal: 28,
    paddingVertical: 14,
    backgroundColor: "rgba(255,60,60,0.9)",
    borderRadius: 24,
    alignItems: "center",
    zIndex: 20,
    minWidth: 160,
  },
  deleteButtonText: { color: "#fff", fontWeight: "600", fontSize: 15 },

  // ── Share overlay ────────────────────────────────────────
  shareOverlayBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  shareOverlayCard: {
    width: "100%",
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 10,
  },
  shareModalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  shareModalTitle: { fontSize: 18, fontWeight: "700", color: "#111" },
  shareModalClose: { fontSize: 18, color: "#999", padding: 4 },
  shareInputRow: { flexDirection: "row", gap: 8, marginBottom: 4 },
  shareInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#e0e0e0",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 14,
    color: "#111",
    backgroundColor: "#fafafa",
  },
  shareSubmitButton: {
    backgroundColor: "#111",
    paddingHorizontal: 18,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 64,
  },
  shareSubmitText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  shareList: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#f0f0f0",
    paddingTop: 12,
  },
  shareListTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "#999",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  shareListRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    gap: 10,
  },
  shareListAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  shareListAvatarLetter: { color: "#fff", fontSize: 14, fontWeight: "700" },
  shareListEmail: { flex: 1, fontSize: 14, color: "#333" },
  removeButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: "rgba(255,60,60,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,60,60,0.2)",
  },
  removeButtonText: {
    fontSize: 12,
    color: "rgba(220,40,40,0.9)",
    fontWeight: "600",
  },
  webViewerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    width: "100%",
    justifyContent: "center",
  },
  arrowButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  arrowButtonDisabled: {
    opacity: 0.2,
  },
  arrowText: {
    color: "#fff",
    fontSize: 32,
    fontWeight: "300",
    lineHeight: 36,
  },
  photoCounter: {
    position: "absolute",
    top: 56,
    left: 0,
    right: 0,
    textAlign: "center",
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    fontWeight: "500",
  },
  swipeHint: {
    marginTop: 12,
    color: "rgba(255,255,255,0.4)",
    fontSize: 12,
    textAlign: "center",
  },
});
