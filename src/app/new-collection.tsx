import PaywallModal from "@/components/PaywallModal";
import UploadProgressOverlay from "@/components/UploadProgressOverlay";
import { useAuth } from "@/contexts/AuthContext";
import { showAlert } from "@/utils/alert";
import { bumpCollectionsVersion } from "@/utils/collectionsCache";
import { setCollectionMemoryDate } from "@/utils/collections";
import MemoryDatePicker from "@/components/MemoryDatePicker";
import {
  clearPendingCollectionUpload,
  clearPendingUploadHint,
  getPendingCollectionUpload,
  markPendingUploadHint,
  savePendingCollectionUpload,
} from "@/utils/pendingUpload";
import {
  clearNativePendingUpload,
  getNativePendingUpload,
  saveNativePendingUpload,
} from "@/utils/pendingUploadNative";
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
  // Memory date — optional, so these are plain strings rather than a Date;
  // an empty set of fields is a valid "no date" state, not a partial one.
  const [memoryDateIso, setMemoryDateIso] = useState<string | null>(null);
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
  // Distinguishes "uploading photos the user just picked" from "finishing
  // an upload that survived a payment redirect" — same overlay, different
  // label, so it reads as a continuation rather than a brand new action.
  const [resuming, setResuming] = useState(false);
  const resumeAttemptedRef = useRef(false);

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

  // ── Resume an upload that survived a payment redirect ────────────────
  // Web: if the Pesapal popup got blocked, buying a plan from the paywall
  // falls back to a same-tab redirect — a real page navigation that wipes
  // React state (see utils/pendingUpload.ts). subscription-callback.tsx
  // sends the user back to THIS screen when it detects a saved draft.
  //
  // Native: no popup/redirect involved, but the OS can kill the app
  // process outright while the payment browser is open (aggressively
  // battery-optimized Android skins like MIUI do this readily), which
  // has the same net effect — everything in memory is gone. When that
  // happens, app/_layout.tsx's cold-launch handler routes back here the
  // same way, using a saved draft on disk instead (see
  // utils/pendingUploadNative.ts).
  //
  // Either way, this effect is what actually finishes the job once we
  // land here, picking the persisted photos back up and uploading them
  // without any further action from the user.
  useEffect(() => {
    if (!session || resumeAttemptedRef.current) return;
    resumeAttemptedRef.current = true;
    resumePendingUpload();
  }, [session]);

  async function pollForActiveSubscription(): Promise<boolean> {
    // The Pesapal webhook that activates the subscription runs
    // asynchronously and may not have landed the instant we're routed
    // back — poll briefly rather than treating that timing gap as a
    // failure.
    for (let attempt = 0; attempt < 8; attempt++) {
      const status = await checkSubscription();
      if (status.isActive) {
        setSubscriptionStatus(status);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return false;
  }

  async function resumePendingUpload() {
    if (Platform.OS === "web") await resumeWebPendingUpload();
    else await resumeNativePendingUpload();
  }

  async function resumeWebPendingUpload() {
    const pending = await getPendingCollectionUpload();
    if (!pending || !session || pending.ownerId !== session.user.id) return;

    // The hint has done its job (getting subscription-callback.tsx to
    // route back here) — clear it now so it doesn't linger for later,
    // unrelated visits in the same tab session. The actual IndexedDB
    // record stays until the upload genuinely succeeds (see below).
    clearPendingUploadHint();

    setResuming(true);
    setCreating(true);
    setUploadProgress({ total: pending.photos.length, completed: 0 });

    try {
      const active = await pollForActiveSubscription();
      if (!active) {
        // Leave the draft in IndexedDB untouched so reloading (or
        // reopening this screen) can pick it up and retry — don't lose
        // the photos over what's most likely just a slow webhook.
        showAlert(
          "Still confirming your payment",
          "We're still waiting for your payment to be confirmed. Reopen New Collection in a moment and we'll finish creating it automatically.",
        );
        return;
      }

      await Promise.all(
        pending.photos.map(async (photo) => {
          const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
          const blobUrl = URL.createObjectURL(photo.blob);
          try {
            await uploadToS3(
              pending.ownerId,
              pending.collectionName,
              fileName,
              blobUrl,
              photo.width,
              photo.height,
            );
          } finally {
            URL.revokeObjectURL(blobUrl);
          }
          setUploadProgress((prev) => ({
            ...prev,
            completed: prev.completed + 1,
          }));
        }),
      );

      // Best-effort, same as the normal create flow below.
      try {
        await setCollectionMemoryDate(
          pending.ownerId,
          pending.collectionName,
          pending.memoryDateIso,
        );
      } catch (dateError: any) {
        console.warn("Save memory date error (resume):", dateError.message);
      }

      // Only clear the draft once everything actually succeeded — if
      // something above throws, keeping it around means a reload can
      // retry rather than the user losing their photos outright.
      await clearPendingCollectionUpload();
      bumpCollectionsVersion();
      goBack();
    } catch (error: any) {
      console.error("Resume pending upload error:", error.message);
      showAlert(
        "Payment succeeded, upload didn't finish",
        "Your payment went through, but something interrupted the upload. Your photos are still saved — reopen New Collection to try again.",
      );
    } finally {
      setCreating(false);
      setResuming(false);
      setUploadProgress({ total: 0, completed: 0 });
    }
  }

  async function resumeNativePendingUpload() {
    const pending = await getNativePendingUpload();
    if (!pending || !session || pending.ownerId !== session.user.id) return;

    setResuming(true);
    setCreating(true);
    setUploadProgress({ total: pending.photos.length, completed: 0 });

    try {
      const active = await pollForActiveSubscription();
      if (!active) {
        // Leave the draft on disk so reopening this screen can pick it
        // up and retry — don't lose the photos over what's most likely
        // just a slow webhook.
        showAlert(
          "Still confirming your payment",
          "We're still waiting for your payment to be confirmed. Reopen New Collection in a moment and we'll finish creating it automatically.",
        );
        return;
      }

      await Promise.all(
        pending.photos.map(async (photo) => {
          const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
          await uploadToS3(
            pending.ownerId,
            pending.collectionName,
            fileName,
            photo.uri,
            photo.width,
            photo.height,
          );
          setUploadProgress((prev) => ({
            ...prev,
            completed: prev.completed + 1,
          }));
        }),
      );

      try {
        await setCollectionMemoryDate(
          pending.ownerId,
          pending.collectionName,
          pending.memoryDateIso,
        );
      } catch (dateError: any) {
        console.warn("Save memory date error (resume):", dateError.message);
      }

      await clearNativePendingUpload();
      bumpCollectionsVersion();
      goBack();
    } catch (error: any) {
      console.error("Resume pending upload error:", error.message);
      showAlert(
        "Payment succeeded, upload didn't finish",
        "Your payment went through, but something interrupted the upload. Your photos are still saved — reopen New Collection to try again.",
      );
    } finally {
      setCreating(false);
      setResuming(false);
      setUploadProgress({ total: 0, completed: 0 });
    }
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }

  async function pickPhotos() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      showAlert(
        "Permission needed",
        "Please allow access to your photo library.",
      );
      return;
    }

    setPickingPhotos(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 0.8,
        // No OS-level cap here at all, for anyone — free or paying.
        // createCollection() is what tells them they've gone over their
        // plan's limit and offers one that fits, once they actually try
        // to create the collection. Capping selectionLimit at pick time
        // (the old behaviour) blocked native users from ever selecting
        // past their limit in the first place, so upgrading afterwards
        // didn't help — they'd already been stopped short by the OS
        // picker before getting anywhere near "Create".
        selectionLimit: 0,
      });

      if (!result.canceled) {
        // Merge into whatever's already selected rather than replacing it —
        // the native picker (PHPicker on iOS, the Android Photo Picker) has
        // no way to be told "these are already selected" and always opens
        // blank, so if we just took its result at face value here, tapping
        // "Select Photos" again to add more would silently wipe everything
        // picked so far. De-dupe by assetId (falling back to uri, which is
        // always present) so re-selecting an already-picked photo in a
        // later session doesn't add it twice.
        setSelectedAssets((prev) => {
          const alreadyPicked = new Set(
            prev.map((a) => a.assetId ?? a.uri),
          );
          const newOnes = result.assets.filter(
            (a) => !alreadyPicked.has(a.assetId ?? a.uri),
          );
          return [...prev, ...newOnes];
        });
      }
    } finally {
      setPickingPhotos(false);
    }
  }

  function removeSelectedAsset(index: number) {
    setSelectedAssets((prev) => prev.filter((_, i) => i !== index));
  }

  async function createCollection() {
    if (!collectionName.trim()) {
      showAlert("Name required", "Please enter a name for the collection.");
      return;
    }
    if (selectedAssets.length === 0) {
      showAlert("Photos required", "Please select at least one photo.");
      return;
    }
    if (!session) {
      // Silently no-op-ing here used to leave "nothing happens" when
      // tapped right after a cold-launch resume (e.g. on a device that
      // killed the app mid-payment and just relaunched it), since the
      // session takes a moment to rehydrate from storage. Tell the user
      // something's happening instead of looking broken.
      showAlert(
        "Just a moment",
        "Still signing you in — please try again in a second.",
      );
      return;
    }

    const maxCollections = subscriptionStatus?.limits?.maxCollections ?? 3;
    const isActive = subscriptionStatus?.isActive ?? false;

    if (existingCount >= maxCollections) {
      if (isActive) {
        showAlert(
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
    if (selectedAssets.length > maxPhotos) {
      // Already on the top tier — no plan left to offer, so there's
      // nothing the paywall could actually fix. Ask them to trim the
      // selection instead of opening a modal with no upgrade option.
      if (isActive && subscriptionStatus?.tier === "big") {
        const over = selectedAssets.length - maxPhotos;
        showAlert(
          "Photo limit reached",
          `Your ${subscriptionStatus?.limits?.label ?? "Big Album"} plan allows up to ${maxPhotos} photos per collection — that's the highest available. Remove ${over} photo${over === 1 ? "" : "s"} to continue.`,
        );
        return;
      }
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
      showAlert("Name taken", "A collection with this name already exists.");
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
      // Best-effort — the collection itself is already created (it
      // exists as soon as it has photos), so a failure here shouldn't
      // undo that or block navigating away.
      //
      // Every collection created from this point forward gets a
      // `collections` row regardless of whether a memory date was set —
      // pass null when it wasn't rather than skipping the write. This
      // only affects newly created collections; older ones that predate
      // this change simply continue to have no row, which the rest of
      // the app already treats identically to "no date set" (see
      // getCollectionMemoryDate), so nothing needs to change there and
      // nothing is backfilled.
      try {
        await setCollectionMemoryDate(
          session.user.id,
          collectionName.trim(),
          memoryDateIso,
        );
      } catch (dateError: any) {
        console.warn("Save memory date error:", dateError.message);
      }

      // If a draft was saved before payment (onBeforePurchase) but we
      // got here through the normal flow rather than the resume path —
      // e.g. the screen never actually lost its state — clear it so it
      // can't linger and get mistaken for a genuine pending upload on
      // some later, unrelated mount. Best-effort and native-only; no-ops
      // harmlessly if there was never a draft.
      if (Platform.OS !== "web") {
        clearNativePendingUpload().catch(() => {});
      }

      // Success — go back to the home screen. It only refetches on focus
      // if this bump actually changed anything since its last fetch (see
      // utils/collectionsCache.ts) — otherwise a recent-enough visit
      // would skip straight past the new collection.
      bumpCollectionsVersion();
      goBack();
    } catch (error: any) {
      console.error("Create collection error:", error.message);
      showAlert("Error", "Something went wrong. Please try again.");
    } finally {
      setCreating(false);
      setUploadProgress({ total: 0, completed: 0 });
    }
  }

  // ── Persist the picked photos before payment ─────────────────────────
  // Passed to PaywallModal as onBeforePurchase, which awaits this after
  // it's already kicked off the payment (opened the popup on web, or
  // right before opening the in-app browser on native), so it never
  // delays or interferes with anything time-sensitive on either path.
  //
  // Web needs the actual bytes (see utils/pendingUpload.ts) because a
  // same-tab redirect fallback wipes the blob: URLs backing selectedAssets
  // entirely. Native just needs to remember which files to upload and
  // where (see utils/pendingUploadNative.ts) — the picker's URIs already
  // point to real files on disk that survive an app process restart —
  // but it still needs *something* persisted in case the OS kills the
  // app outright while the payment browser is open.
  async function persistPendingUploadForPayment() {
    if (!session || selectedAssets.length === 0) return;

    try {
      if (Platform.OS === "web") {
        const photos = await Promise.all(
          selectedAssets.map(async (asset) => {
            const res = await fetch(asset.uri);
            const blob = await res.blob();
            return {
              name: asset.fileName ?? `${Date.now()}.jpg`,
              blob,
              width: asset.width,
              height: asset.height,
            };
          }),
        );

        await savePendingCollectionUpload({
          ownerId: session.user.id,
          collectionName: collectionName.trim(),
          memoryDateIso,
          photos,
        });
        markPendingUploadHint();
      } else {
        await saveNativePendingUpload({
          ownerId: session.user.id,
          collectionName: collectionName.trim(),
          memoryDateIso,
          photos: selectedAssets.map((asset) => ({
            uri: asset.uri,
            width: asset.width,
            height: asset.height,
          })),
        });
      }
    } catch (error: any) {
      // Best-effort — if this fails, the user just ends up back at the
      // pre-fix behaviour (reselect photos / retap Create after paying)
      // rather than anything actually breaking.
      console.warn("persistPendingUploadForPayment error:", error.message);
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

        <View style={styles.dateLabelRow}>
          <Text style={styles.label}>Memory date</Text>
          <Text style={styles.optionalTag}>Optional</Text>
        </View>
        <Text style={styles.dateHint}>
          When did these memories actually happen? Leave blank if you'd rather
          not say.
        </Text>
        <MemoryDatePicker value={memoryDateIso} onChange={setMemoryDateIso} />

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
              <View key={asset.assetId ?? asset.uri} style={styles.previewThumbWrap}>
                <Image
                  source={{ uri: asset.uri }}
                  style={styles.previewThumb}
                  contentFit="cover"
                />
                <TouchableOpacity
                  style={styles.previewRemoveButton}
                  onPress={() => removeSelectedAsset(i)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close" size={13} color="#fff" />
                </TouchableOpacity>
              </View>
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
        selectedCount={
          paywallReason === "photos" ? selectedAssets.length : undefined
        }
        currentTier={
          subscriptionStatus?.isActive
            ? (subscriptionStatus.tier as any)
            : "free"
        }
        currentPaymentProvider={subscriptionStatus?.paymentProvider ?? null}
        currentGooglePlayPurchaseToken={
          subscriptionStatus?.googlePlayPurchaseToken ?? null
        }
        onBeforePurchase={persistPendingUploadForPayment}
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
          // Declined to pay — trim back down to what their current plan
          // actually allows rather than leaving an over-limit selection
          // sitting in state (Create would otherwise just re-show this
          // same paywall in a loop).
          if (paywallReason === "photos") {
            const cap = subscriptionStatus?.limits?.maxPhotosPerCollection ?? 10;
            setSelectedAssets((prev) => prev.slice(0, cap));
          }
        }}
      />

      <UploadProgressOverlay
        visible={creating}
        total={uploadProgress.total}
        completed={uploadProgress.completed}
        label={
          resuming
            ? "Payment confirmed — finishing your collection"
            : "Creating your collection"
        }
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

  dateLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 20,
    marginBottom: 8,
  },
  optionalTag: {
    fontSize: 10,
    fontWeight: "700",
    color: "#bbb",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    backgroundColor: "#f5f5f5",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  dateHint: {
    fontSize: 13,
    color: "#999",
    lineHeight: 18,
    marginBottom: 12,
    marginTop: -4,
  },
  dateRow: { flexDirection: "row", gap: 10 },
  dateInputSmall: { width: 70, textAlign: "center" },
  dateInputLarge: { flex: 1, textAlign: "center" },

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
  previewThumbWrap: {
    width: 80,
    height: 80,
    marginRight: 8,
  },
  previewThumb: {
    width: 80,
    height: 80,
    borderRadius: 10,
    backgroundColor: "#eee",
  },
  previewRemoveButton: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center",
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
