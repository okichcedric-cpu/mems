import { Ionicons } from "@expo/vector-icons";
import { Session } from "@supabase/supabase-js";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
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
import { deleteCollection, deleteFromS3, uploadToS3 } from "../../utils/s3";
import {
  getCollectionShares,
  shareCollection,
  unshareCollection,
} from "../../utils/sharing";
import {
  checkSubscription,
  SubscriptionStatus,
} from "../../utils/subscription";
import { supabase } from "../../utils/supabase";

const SCREEN_WIDTH = Dimensions.get("window").width;
const SCREEN_HEIGHT = Dimensions.get("window").height;
const COLUMN_WIDTH = (SCREEN_WIDTH - 32) / 2;

type Photo = {
  key: string;
  url: string;
  thumbUrl?: string;
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
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareEmail, setShareEmail] = useState("");
  const [sharing, setSharing] = useState(false);
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [effectiveOwnerId, setEffectiveOwnerId] = useState<string | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] =
    useState<SubscriptionStatus | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(
    null,
  );

  // Toast system
  const [toast, setToast] = useState<{
    message: string;
    emoji: string;
    subtext?: string;
    showUpgrade?: boolean;
  } | null>(null);
  const toastAnim = useRef(new Animated.Value(0)).current;

  function showToast(
    message: string,
    emoji: string = "✨",
    subtext?: string,
    showUpgrade: boolean = false,
  ) {
    // Reset animation value before starting
    toastAnim.setValue(0);
    setToast({ message, emoji, subtext, showUpgrade });
    Animated.sequence([
      Animated.spring(toastAnim, {
        toValue: 1,
        useNativeDriver: true,
        tension: 80,
        friction: 10,
      }),
      Animated.delay(3500),
      Animated.timing(toastAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start(() => setToast(null));
  }

  const swipeX = useRef(new Animated.Value(0)).current;
  const fileInputRef = useRef<any>(null);

  const isOwner = session?.user?.id === (effectiveOwnerId ?? session?.user?.id);
  const leftColumn = photos.filter((_, i) => i % 2 === 0);
  const rightColumn = photos.filter((_, i) => i % 2 !== 0);

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
        checkSubscription().then(setSubscriptionStatus);
      } else {
        setLoading(false);
      }
    });
  }, []);

  // Create hidden file input imperatively on web
  useEffect(() => {
    if (Platform.OS !== "web") return;

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    fileInputRef.current = input;

    const handleChange = async (event: Event) => {
      const allFiles = (event.target as HTMLInputElement).files;
      if (!allFiles || allFiles.length === 0) return;

      // Filter images only
      const files = Array.from(allFiles).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length === 0) {
        window.alert("Please select image files only (JPG, PNG, HEIC, etc.)");
        input.value = "";
        return;
      }

      setUploading(true);
      try {
        const currentSession = await supabase.auth.getSession();
        const sess = currentSession.data.session;
        if (!sess) return;

        const currentOwner = fileInputRef.current?._ownerId ?? sess.user.id;

        await Promise.all(
          files.map(async (file: File) => {
            const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
            const uri = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            await uploadToS3(currentOwner, collectionName, fileName, uri, 0, 0);
          }),
        );

        const { data, error } = await supabase.functions.invoke("list-photos", {
          body: { userId: currentOwner, collectionName, includeUrls: true },
        });
        if (!error) {
          const photoList = (data?.photos || []).filter(
            (p: any) => p.Key && !p.Key.includes("/thumbs/"),
          );
          setPhotos(
            photoList.map((p: any) => ({
              key: p.Key,
              url: p.url,
              thumbUrl: p.thumbUrl ?? p.url,
              width: p.metadata?.width ?? 1,
              height: p.metadata?.height ?? 1,
            })),
          );
        }
      } catch (error: any) {
        window.alert("Upload failed: " + error.message);
      } finally {
        setUploading(false);
        input.value = "";
      }
    };

    input.addEventListener("change", handleChange);

    return () => {
      input.removeEventListener("change", handleChange);
      if (document.body.contains(input)) {
        document.body.removeChild(input);
      }
    };
  }, [collectionName]);

  // Keep owner ID synced to the file input handler
  useEffect(() => {
    if (fileInputRef.current && effectiveOwnerId) {
      fileInputRef.current._ownerId = effectiveOwnerId;
    }
  }, [effectiveOwnerId]);

  async function fetchPhotos(currentSession: Session, ownerId?: string) {
    const owner = ownerId ?? effectiveOwnerId ?? currentSession.user.id;
    try {
      const { data, error } = await supabase.functions.invoke("list-photos", {
        body: { userId: owner, collectionName, includeUrls: true },
      });
      if (error) throw new Error(error.message);

      const photoList = (data?.photos || []).filter(
        (p: any) => p.Key && !p.Key.includes("/thumbs/"),
      );

      if (photoList.length === 0) {
        setPhotos([]);
        return;
      }

      setPhotos(
        photoList.map((p: any) => ({
          key: p.Key,
          url: p.url,
          thumbUrl: p.thumbUrl ?? p.url,
          width: p.metadata?.width ?? 1,
          height: p.metadata?.height ?? 1,
        })),
      );
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

  function openPhoto(index: number) {
    swipeX.setValue(0);
    setSelectedPhotoIndex(index);
  }

  function goToNext() {
    setSelectedPhotoIndex((prev) => {
      if (prev === null || prev >= photos.length - 1) return prev;
      swipeX.setValue(0);
      return prev + 1;
    });
  }

  function goToPrev() {
    setSelectedPhotoIndex((prev) => {
      if (prev === null || prev <= 0) return prev;
      swipeX.setValue(0);
      return prev - 1;
    });
  }

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 10,
      onPanResponderMove: (_, gs) => {
        swipeX.setValue(gs.dx);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dx < -80) goToNext();
        else if (gs.dx > 80) goToPrev();
        Animated.spring(swipeX, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  // Central limit check — returns true if upload can proceed, false if blocked
  function checkPhotoLimit(
    subStatus: SubscriptionStatus | null,
    photoCount: number,
  ): boolean {
    const isSubscribed = subStatus?.isSubscribed ?? false;
    const maxPhotos = subStatus?.limits?.maxPhotosPerCollection ?? 10;

    if (photoCount < maxPhotos) return true; // Under limit — allow

    if (isSubscribed) {
      // Pro user hit their 75 photo limit
      showToast(
        `You've reached the ${maxPhotos} photo limit for this collection.`,
        "📸",
        "Delete some photos to add more.",
        false,
      );
      return false;
    }

    if (!isOwner) {
      // Non-subscribed recipient of a shared collection
      showToast(
        `This collection has reached the ${maxPhotos} photo limit.`,
        "📸",
        "Subscribe to Mems Pro to add more photos.",
        true,
      );
      return false;
    }

    // Non-subscribed owner — show paywall
    setShowPaywall(true);
    return false;
  }

  async function uploadPhoto() {
    // Fetch fresh subscription status
    let subStatus = subscriptionStatus;
    if (!subStatus) {
      subStatus = await checkSubscription();
      setSubscriptionStatus(subStatus);
    }

    const realPhotos = photos.filter((p) => !p.key.includes("/thumbs/"));

    // Check limit before opening picker
    if (!checkPhotoLimit(subStatus, realPhotos.length)) return;

    // Desktop web — trigger hidden file input
    if (Platform.OS === "web") {
      if (fileInputRef.current) fileInputRef.current.click();
      return;
    }

    // Native mobile — use ImagePicker
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission needed",
        "Please allow access to your photo library.",
      );
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
      setSelectedPhotoIndex(null);
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
          source={{ uri: item.thumbUrl ?? item.url }}
          style={[styles.photo, StyleSheet.absoluteFill]}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={item.key}
          transition={{ duration: 200, effect: "cross-dissolve" }}
        />
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => {
              // router.back() fails after a page reload — no history exists
              // canGoBack() check ensures we fall back to home safely
              if (router.canGoBack()) {
                router.back();
              } else {
                router.replace("/");
              }
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="arrow-back" size={22} color="#111" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => router.replace("/")}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="home-outline" size={22} color="#111" />
          </TouchableOpacity>
        </View>

        <View style={styles.headerCenter} />

        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.uploadIconButton}
            onPress={uploadPhoto}
            disabled={uploading}
            activeOpacity={0.7}
          >
            {uploading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Ionicons name="add" size={22} color="#fff" />
            )}
          </TouchableOpacity>

          {isOwner && (
            <TouchableOpacity
              style={styles.shareTextButton}
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
                <Text style={styles.shareTextButtonLabel}>Share</Text>
              )}
            </TouchableOpacity>
          )}

          {isOwner && (
            <TouchableOpacity
              style={styles.iconButton}
              onPress={handleDeleteCollection}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons
                name="trash-outline"
                size={22}
                color="rgba(255,60,60,0.8)"
              />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Collection name banner */}
      <View style={styles.collectionBanner}>
        <Text style={styles.collectionBannerTitle} numberOfLines={1}>
          {collectionName}
        </Text>
        <Text style={styles.collectionBannerSubtitle}>
          {photos.length} photo{photos.length !== 1 ? "s" : ""}
          {subscriptionStatus?.limits?.maxPhotosPerCollection
            ? ` · ${subscriptionStatus.limits.maxPhotosPerCollection} max`
            : ""}
        </Text>
      </View>

      {/* Avatar strip */}
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
          <Text style={styles.emptyText}>Tap + to upload photos</Text>
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

      {/* Full Screen Photo Viewer — full screen FlatList with paging */}
      <Modal
        visible={selectedPhotoIndex !== null}
        transparent={false}
        animationType="fade"
        statusBarTranslucent
      >
        <View style={styles.fullScreenViewer}>
          {/* Close button */}
          <TouchableOpacity
            style={styles.fullScreenClose}
            onPress={() => setSelectedPhotoIndex(null)}
            hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
          >
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>

          {/* Counter */}
          {selectedPhotoIndex !== null && (
            <View style={styles.fullScreenCounter}>
              <Text style={styles.fullScreenCounterText}>
                {selectedPhotoIndex + 1} / {photos.length}
              </Text>
            </View>
          )}

          {/* Full screen scrollable image list */}
          {selectedPhotoIndex !== null && Platform.OS !== "web" && (
            <FlatList
              data={photos}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              initialScrollIndex={selectedPhotoIndex}
              keyExtractor={(item) => item.key}
              getItemLayout={(_, index) => ({
                length: SCREEN_WIDTH,
                offset: SCREEN_WIDTH * index,
                index,
              })}
              onMomentumScrollEnd={(e) => {
                const newIndex = Math.round(
                  e.nativeEvent.contentOffset.x / SCREEN_WIDTH,
                );
                setSelectedPhotoIndex(newIndex);
              }}
              renderItem={({ item }) => (
                <View style={styles.fullScreenPage}>
                  <Image
                    source={{ uri: item.url }}
                    style={styles.fullScreenImage}
                    contentFit="contain"
                    cachePolicy="memory-disk"
                    recyclingKey={item.key}
                    transition={{ duration: 150, effect: "cross-dissolve" }}
                  />
                </View>
              )}
              windowSize={3}
              maxToRenderPerBatch={3}
              initialNumToRender={3}
            />
          )}

          {/* Web — arrows flanking full screen image */}
          {selectedPhotoIndex !== null && Platform.OS === "web" && (
            <View style={styles.webViewerWrapper}>
              <TouchableOpacity
                onPress={goToPrev}
                disabled={selectedPhotoIndex === 0}
                style={[
                  styles.webArrow,
                  selectedPhotoIndex === 0 && styles.webArrowDisabled,
                ]}
              >
                <Text style={styles.webArrowText}>‹</Text>
              </TouchableOpacity>
              <Image
                source={{ uri: photos[selectedPhotoIndex].url }}
                style={styles.fullScreenWebImage}
                contentFit="contain"
                cachePolicy="memory-disk"
              />
              <TouchableOpacity
                onPress={goToNext}
                disabled={selectedPhotoIndex === photos.length - 1}
                style={[
                  styles.webArrow,
                  selectedPhotoIndex === photos.length - 1 &&
                    styles.webArrowDisabled,
                ]}
              >
                <Text style={styles.webArrowText}>›</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Swipe hint — mobile only, first open */}
          {Platform.OS !== "web" && photos.length > 1 && (
            <Text style={styles.swipeHint}>← swipe to navigate →</Text>
          )}

          {/* Delete — owner only */}
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

      {/* Share Modal — View overlay on web prevents body style corruption on mobile browsers */}
      {showShareModal &&
        (Platform.OS === "web" ? (
          <View style={styles.shareWebOverlay}>
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
                    style={[
                      styles.shareSubmitButton,
                      sharing && { opacity: 0.6 },
                    ]}
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
          </View>
        ) : (
          <Modal
            visible={showShareModal}
            transparent
            animationType="fade"
            statusBarTranslucent
            onRequestClose={() => setShowShareModal(false)}
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
                    style={[
                      styles.shareSubmitButton,
                      sharing && { opacity: 0.6 },
                    ]}
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
        ))}

      {/* Toast notification */}
      {toast && (
        <Animated.View
          style={[
            styles.toast,
            {
              opacity: toastAnim,
              transform: [
                {
                  translateY: toastAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [20, 0],
                  }),
                },
              ],
            },
          ]}
          pointerEvents="box-none"
        >
          <Text style={styles.toastEmoji}>{toast.emoji}</Text>
          <View style={styles.toastTextContainer}>
            <Text style={styles.toastMessage}>{toast.message}</Text>
            {toast.subtext ? (
              <Text style={styles.toastSubtext}>{toast.subtext}</Text>
            ) : null}
          </View>
          {toast.showUpgrade && (
            <TouchableOpacity
              onPress={() => router.push("/subscription")}
              style={styles.toastButton}
            >
              <Text style={styles.toastButtonText}>Upgrade</Text>
            </TouchableOpacity>
          )}
        </Animated.View>
      )}
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
    paddingHorizontal: 12,
    paddingTop: Platform.OS === "web" ? 16 : 56,
    paddingBottom: 12,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    minHeight: Platform.OS === "web" ? 64 : 100,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 4, flex: 1 },
  headerCenter: { flex: 0 },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
    justifyContent: "flex-end",
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 15, fontWeight: "700", color: "#111" },
  subtitle: { fontSize: 11, color: "#999", marginTop: 2 },

  // ── Collection name banner ────────────────────────────────
  collectionBanner: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 12,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 8,
      },
      android: { elevation: 3 },
      web: { boxShadow: "0 2px 12px rgba(0,0,0,0.06)" } as any,
    }),
  },
  collectionBannerTitle: {
    fontSize: Platform.OS === "web" ? 22 : 20,
    fontWeight: "800",
    color: "#111",
    letterSpacing: -0.3,
  },
  collectionBannerSubtitle: {
    fontSize: 12,
    color: "#999",
    marginTop: 3,
    fontWeight: "500",
  },

  // ── Upload button ─────────────────────────────────────────
  uploadIconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#111",
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      web: { cursor: "pointer" } as any,
      default: {},
    }),
  },

  // ── Share button ─────────────────────────────────────────
  shareTextButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#111",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  shareTextButtonLabel: { fontSize: 13, color: "#111", fontWeight: "600" },
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

  // ── Full screen photo viewer ──────────────────────────────
  fullScreenViewer: {
    flex: 1,
    backgroundColor: "#000",
  },
  fullScreenClose: {
    position: "absolute",
    top: Platform.OS === "web" ? 20 : 52,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 50,
  },
  fullScreenCounter: {
    position: "absolute",
    top: Platform.OS === "web" ? 26 : 58,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 50,
  },
  fullScreenCounterText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 14,
    fontWeight: "600",
  },
  fullScreenPage: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
  },
  fullScreenImage: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
  fullScreenWebImage: {
    flex: 1,
    height: SCREEN_HEIGHT,
  },
  // Legacy — kept for safety
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    justifyContent: "center",
    alignItems: "center",
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
    zIndex: 50,
  },
  modalCloseText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  photoCounter: {
    position: "absolute",
    top: 56,
    left: 0,
    right: 0,
    textAlign: "center",
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    fontWeight: "500",
    zIndex: 50,
  },
  webViewerWrapper: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: SCREEN_HEIGHT,
    gap: 0,
  },
  webArrow: {
    width: 64,
    height: "100%" as any,
    backgroundColor: "rgba(255,255,255,0.05)",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  webArrowDisabled: { opacity: 0.1 },
  webArrowText: {
    color: "#fff",
    fontSize: 48,
    fontWeight: "200",
    lineHeight: 52,
    textAlign: "center",
  },
  webPhotoCard: {
    flex: 1,
    height: SCREEN_HEIGHT * 0.75,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  mobilePhotoCard: {
    width: SCREEN_WIDTH - 24,
    height: SCREEN_HEIGHT * 0.72,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  modalImage: { width: "100%", height: "100%" },
  swipeHint: {
    position: "absolute",
    bottom: 100,
    left: 0,
    right: 0,
    textAlign: "center",
    color: "rgba(255,255,255,0.35)",
    fontSize: 12,
  },
  deleteButton: {
    position: "absolute",
    bottom: 40,
    alignSelf: "center",
    paddingHorizontal: 28,
    paddingVertical: 14,
    backgroundColor: "rgba(255,60,60,0.85)",
    borderRadius: 24,
    alignItems: "center",
    minWidth: 160,
    zIndex: 50,
  },
  deleteButtonText: { color: "#fff", fontWeight: "600", fontSize: 15 },

  // ── Share overlay ────────────────────────────────────────
  shareWebOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999,
  },
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

  // ── Toast ─────────────────────────────────────────────────
  toast: {
    position: "absolute",
    bottom: 32,
    left: 16,
    right: 16,
    backgroundColor: "#1a1a1a",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 12,
    zIndex: 999,
  },
  toastEmoji: { fontSize: 26 },
  toastTextContainer: { flex: 1 },
  toastMessage: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fff",
    lineHeight: 18,
  },
  toastSubtext: {
    fontSize: 11,
    color: "rgba(255,255,255,0.5)",
    marginTop: 3,
    lineHeight: 15,
  },
  toastButton: {
    backgroundColor: "#4AE8A0",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    flexShrink: 0,
  },
  toastButtonText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#111",
  },
});
