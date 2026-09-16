import { Ionicons } from "@expo/vector-icons";
import { Session } from "@supabase/supabase-js";
import * as Sentry from "@sentry/react-native";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AlbumBackground from "../../components/AlbumBackground";
import MemoryDatePicker from "../../components/MemoryDatePicker";
import PaywallModal from "../../components/PaywallModal";
import {
  INERT_FLIP_ANIM,
  PhotoFlipCard,
  type Photo,
} from "../../components/PhotoFlipCard";
import UploadProgressOverlay from "../../components/UploadProgressOverlay";
import { useAuth } from "../../contexts/AuthContext";
import { showAlert } from "../../utils/alert";
import {
  bumpCollectionVersion,
  dropCollectionCache,
  getCachedCollectionPhotos,
  setCachedCollectionPhotos,
} from "../../utils/collectionsCache";
import {
  getCollectionMemoryDate,
  setCollectionMemoryDate,
} from "../../utils/collections";
import { deriveThumbKey, evictPhotosFromCache } from "../../utils/imageCache";
import { getMemoryDateInfo } from "../../utils/memoryDate";
import { deletePhotoCaption, setPhotoCaption } from "../../utils/photoCaptions";
import {
  deleteCollection,
  deleteFromS3,
  renameCollection,
  uploadToS3,
} from "../../utils/s3";
import {
  deletePhotoSharesForPhoto,
  getPhotoShares,
  sharePhoto,
  unsharePhoto,
} from "../../utils/sharedPhotos";
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
const IS_DESKTOP_WEB = Platform.OS === "web" && SCREEN_WIDTH >= 768;

// Mobile web's viewport is shorter than native's to begin with
// (window.innerHeight excludes the browser's address bar/toolbar chrome,
// unlike a native app which owns the full device screen) — so web gets
// its own, tighter top clearance rather than reusing native's. These are
// this SCREEN's own chrome reservations (close button, counter, delete
// button) for centering the polaroid viewer card within a safe zone — see
// fullScreenPage/webImageDragLayer below — independent of the card's own
// internal sizing, which now lives alongside PhotoFlipCard.
const VIEWER_TOP_CHROME = Platform.OS === "web" ? 72 : 104;
const VIEWER_BOTTOM_CHROME = 28;

// Pagination dots — approximate center-to-center spacing (dot width + gap,
// from the pageDot/pageDotsContent styles below), used only to estimate a
// scroll offset that centers the active dot. Doesn't need to be exact —
// scrolling within a few pixels of true center reads as "centered" fine.
const DOT_STRIDE = 15;
// The dots strip only ever shows a small window onto the full row — for a
// collection of, say, 80 photos, all 80 dots existing in a scrollable line
// is still the right data model, but a window this many dots wide is what
// keeps the strip a fixed, glanceable size instead of stretching edge to
// edge. The window itself is centered on screen; scrolling inside it keeps
// the ACTIVE dot centered within that window (see pageDots/pageDotsContent
// below, and the auto-centering effect near selectedPhotoIndex).
const DOTS_VISIBLE = 5;
const DOTS_WINDOW_WIDTH = DOTS_VISIBLE * DOT_STRIDE;

// ── Preload full-res images in the background ──────────────
// Called after photos load — by the time user taps, images are cached
function preloadImages(photoList: Photo[]) {
  setTimeout(() => {
    photoList.forEach((p) => {
      if (!p.url) return;
      if (Platform.OS === "web" && typeof window !== "undefined") {
        const img = new (window as any).Image();
        img.src = p.url;
      } else {
        Image.prefetch(p.url).catch(() => {});
      }
    });
  }, 500); // 500ms delay — lets grid thumbnails render first
}

// ── Magic byte verification ────────────────────────────────
// Reads the first 12 bytes of the file and checks them against
// known image file signatures. Cannot be spoofed by renaming.
async function verifyImageMagicBytes(file: File): Promise<boolean> {
  try {
    const buffer = await file.slice(0, 12).arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // JPEG — FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      return true;

    // PNG — 89 50 4E 47
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    )
      return true;

    // GIF — 47 49 46 38
    if (
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    )
      return true;

    // WebP — 52 49 46 46 ... 57 45 42 50
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    )
      return true;

    // HEIC/HEIF — ftyp marker at offset 4
    if (
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    )
      return true;

    return false;
  } catch {
    // If we can't read the bytes, reject the file
    return false;
  }
}

export default function CollectionPage() {
  const { id, ownerId: ownerIdParam } = useLocalSearchParams<{
    id: string;
    ownerId?: string;
  }>();
  const collectionName = decodeURIComponent(id);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // ── Single source of truth ──────────────────────────────────
  // Previously this screen ran its own independent getSession() call,
  // separate from _layout.tsx's session check — the same architectural
  // bug fixed in index.tsx. See AuthContext.tsx and index.tsx for the
  // full explanation of the race condition this caused.
  const { session } = useAuth();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({
    total: 0,
    completed: 0,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareEmail, setShareEmail] = useState("");
  const [sharing, setSharing] = useState(false);
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  // ── Individual photo share modal ────────────────────────────────
  // Deliberately separate state from the collection-share modal above —
  // scoped to ONE photo (sharePhotoTargetKey) rather than the whole
  // collection, mirroring how the caption modal tracks its own target
  // photo key independently of selectedPhotoIndex.
  const [showSharePhotoModal, setShowSharePhotoModal] = useState(false);
  const [sharePhotoTargetKey, setSharePhotoTargetKey] = useState<
    string | null
  >(null);
  const [sharePhotoEmail, setSharePhotoEmail] = useState("");
  const [sharingPhoto, setSharingPhoto] = useState(false);
  const [photoSharedWith, setPhotoSharedWith] = useState<string[]>([]);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameInput, setRenameInput] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [memoryDate, setMemoryDate] = useState<string | null>(null);
  const [showDateModal, setShowDateModal] = useState(false);
  const [editingDateIso, setEditingDateIso] = useState<string | null>(null);
  const [savingDate, setSavingDate] = useState(false);
  const [effectiveOwnerId, setEffectiveOwnerId] = useState<string | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] =
    useState<SubscriptionStatus | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [paywallReason, setPaywallReason] = useState<"collections" | "photos">(
    "photos",
  );
  const pendingUploadRef = useRef<(() => void) | null>(null);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(
    null,
  );
  // Pagination dots (below the single-photo viewer) live in their own
  // horizontally scrollable strip rather than wrapping onto multiple
  // lines — this keeps the active dot centered even for very large
  // collections. See the effect below, which drives that centering.
  const dotsScrollRef = useRef<ScrollView>(null);

  // ── Hide-on-scroll header/banner ────────────────────────────────
  // Same pattern as the home screen (see app/index.tsx): swiping up
  // through the photo grid slides the header + collection name banner +
  // shared-avatars strip away as one unit so only the photos are on
  // screen; swiping back down brings the whole block back. All three
  // pieces are measured and animated together (one onLayout on their
  // shared wrapper) rather than separately, since the avatar strip only
  // renders once shares have loaded — treating them as one block means
  // that appearing/disappearing just adjusts the measured height rather
  // than needing its own separate animation wiring.
  const [chromeHeight, setChromeHeight] = useState(
    (Platform.OS === "web" ? 16 : insets.top + 6) +
      (Platform.OS === "web" ? 64 : 56) +
      12 +
      64, // rough estimate for the name banner before first real layout
  );
  const gridScrollY = useRef(new Animated.Value(0)).current;
  const clampedGridScrollY = useMemo(
    () => Animated.diffClamp(gridScrollY, 0, chromeHeight),
    [gridScrollY, chromeHeight],
  );
  const chromeTranslateY = clampedGridScrollY.interpolate({
    inputRange: [0, chromeHeight],
    outputRange: [0, -chromeHeight],
    extrapolate: "clamp",
  });
  // See app/index.tsx's identical comment: kept off the native driver on
  // both sides (not just the marginTop side) so the header/banner block
  // and the grid's reserved top space never drift a frame apart. This is
  // its own interpolation (not chromeTranslateY negated) — at rest the
  // margin needs to be a full chromeHeight (grid starts right below the
  // visible chrome), shrinking to 0 as the chrome finishes sliding off;
  // that's the inverse of translateY's range, not its negation.
  const gridMarginTop = clampedGridScrollY.interpolate({
    inputRange: [0, chromeHeight],
    outputRange: [chromeHeight, 0],
    extrapolate: "clamp",
  });
  const handleGridScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: gridScrollY } } }],
    { useNativeDriver: false },
  );

  // Re-centers the active dot every time the selected photo changes —
  // pageDotsContent's own horizontal padding (SCREEN_WIDTH / 2 on each
  // side) is what makes centering possible even for the very first/last
  // dot, which otherwise couldn't scroll far enough to reach the middle.
  useEffect(() => {
    if (selectedPhotoIndex === null) return;
    const x = selectedPhotoIndex * DOT_STRIDE + DOT_STRIDE / 2;
    dotsScrollRef.current?.scrollTo({ x, animated: true });
  }, [selectedPhotoIndex]);

  // ── Photo flip / caption ──────────────────────────────────────
  // Whether the CURRENTLY VIEWED photo is showing its back (caption side)
  // — a single boolean and a single Animated.Value, since only one photo
  // is ever flippable at a time (the FlatList's other rendered items stay
  // on their plain, unflipped front face — see the flip card usage below).
  const [isFlipped, setIsFlipped] = useState(false);
  const flipAnim = useRef(new Animated.Value(0)).current;

  // Resets the flip to the front every time the viewed photo changes, so
  // swiping to the next photo never leaves it showing the previous one's
  // back face.
  useEffect(() => {
    setIsFlipped(false);
    flipAnim.setValue(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPhotoIndex]);

  function toggleFlip() {
    const flippingToBack = !isFlipped;
    Animated.timing(flipAnim, {
      toValue: flippingToBack ? 180 : 0,
      duration: 450,
      useNativeDriver: true,
    }).start();
    setIsFlipped(flippingToBack);
  }

  // ── Caption modal ──────────────────────────────────────────────
  // All caption entry/editing/deletion goes through this one small modal
  // (mirrors the memory-date modal below) rather than an inline TextInput
  // on the flip card's back face — tapping the caption strip's text (to
  // edit) or its "+ Add a caption" prompt (to create) both open this,
  // pre-filled from the tapped photo's current caption.
  const [showCaptionModal, setShowCaptionModal] = useState(false);
  const [captionModalPhotoKey, setCaptionModalPhotoKey] = useState<
    string | null
  >(null);
  const [captionModalDraft, setCaptionModalDraft] = useState("");
  const [captionModalOriginal, setCaptionModalOriginal] = useState("");
  const [savingCaption, setSavingCaption] = useState(false);

  function openCaptionModal(photo: Photo) {
    setCaptionModalPhotoKey(photo.key);
    setCaptionModalDraft(photo.caption ?? "");
    setCaptionModalOriginal(photo.caption ?? "");
    setShowCaptionModal(true);
  }

  // Optimistic local update, mirrors setCollectionMemoryDate's own
  // update-then-write pattern used elsewhere on this screen.
  function applyCaptionLocally(photoKey: string, caption: string | undefined) {
    const owner = effectiveOwnerId ?? session?.user?.id;
    if (!owner) return;
    setPhotos((prev) => {
      const next = prev.map((p) =>
        p.key === photoKey ? { ...p, caption } : p,
      );
      setCachedCollectionPhotos(owner, collectionName, next);
      return next;
    });
    bumpCollectionVersion(owner, collectionName);
  }

  async function handleSaveCaption() {
    if (!session || !captionModalPhotoKey) return;
    const owner = effectiveOwnerId ?? session.user.id;
    const trimmed = captionModalDraft.trim();
    setSavingCaption(true);
    try {
      await setPhotoCaption(owner, captionModalPhotoKey, trimmed);
      applyCaptionLocally(captionModalPhotoKey, trimmed || undefined);
      setShowCaptionModal(false);
    } catch (error: any) {
      console.error("Save caption error:", error.message);
      const msg =
        error.message || "Could not save the caption. Please try again.";
      Platform.OS === "web" ? window.alert(msg) : Alert.alert("Error", msg);
    } finally {
      setSavingCaption(false);
    }
  }

  async function handleDeleteCaption() {
    if (!session || !captionModalPhotoKey) return;
    const owner = effectiveOwnerId ?? session.user.id;
    setSavingCaption(true);
    try {
      await deletePhotoCaption(owner, captionModalPhotoKey);
      applyCaptionLocally(captionModalPhotoKey, undefined);
      setShowCaptionModal(false);
    } catch (error: any) {
      console.error("Delete caption error:", error.message);
      const msg =
        error.message || "Could not delete the caption. Please try again.";
      Platform.OS === "web" ? window.alert(msg) : Alert.alert("Error", msg);
    } finally {
      setSavingCaption(false);
    }
  }

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

  // Depends on `session?.user?.id` (a plain string), NOT on `session`
  // itself or the removed `sessionVersion` counter — both changed on
  // every auth event including routine TOKEN_REFRESHED events that
  // happen automatically in the background and don't represent any
  // real change. That caused this effect to re-run on every token
  // refresh, flipping loading back to true and hiding the photo grid
  // until it reloaded — a visible flicker on every refresh, however
  // often it happened. `user.id` stays stable across any number of
  // refreshes for the same signed-in user, so this now only re-runs
  // on a genuine sign-in or sign-out. See AuthContext.tsx for the
  // full explanation.
  const userId = session?.user?.id ?? null;

  useEffect(() => {
    if (!session) {
      setLoading(false);
      return;
    }
    const owner = ownerIdParam ?? session.user.id;
    setEffectiveOwnerId(owner);

    // Re-opening a collection is a fresh mount (a new push in
    // expo-router, not a refocus of a kept-alive instance the way
    // app/index.tsx works), so local state can't just "still be there"
    // on its own — check the module-level cache from
    // utils/collectionsCache.ts for the equivalent. A hit means nothing
    // has mutated this specific collection since it was last fetched in
    // this tab/session, so the photo grid can render immediately with
    // the same URLs already sitting in the browser's HTTP cache instead
    // of re-downloading every thumbnail.
    const cachedPhotos = getCachedCollectionPhotos(owner, collectionName);
    if (cachedPhotos) {
      setPhotos(cachedPhotos as Photo[]);
      preloadImages(cachedPhotos as Photo[]);
      setLoading(false);
      // Cheap metadata calls, not part of the "feels like a reload"
      // problem (no images involved) — always kept current in the
      // background rather than cached, so sharing/date/plan info never
      // goes stale just because the photo list didn't change.
      loadShares();
      checkSubscription().then(setSubscriptionStatus);
      getCollectionMemoryDate(owner, collectionName).then(setMemoryDate);
      return;
    }

    setLoading(true);
    Promise.all([
      fetchPhotos(session, owner),
      loadShares(),
      checkSubscription().then(setSubscriptionStatus),
      getCollectionMemoryDate(owner, collectionName).then(setMemoryDate),
    ]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

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

      // Show the overlay immediately in indeterminate mode (total=0) —
      // covers the verification steps below too, so there's no gap
      // where nothing visible is happening after picking files
      setUploading(true);
      setUploadProgress({ total: 0, completed: 0 });

      // ── Step 1: filter to image MIME types ──────────────
      const mimeFiltered = Array.from(allFiles).filter(
        (f) => f.type.startsWith("image/") && !f.type.includes("svg"),
      );

      if (mimeFiltered.length === 0) {
        window.alert(
          "Please select image files only (JPG, PNG, WebP, HEIC, GIF).",
        );
        input.value = "";
        setUploading(false);
        return;
      }

      // ── Step 2: magic byte verification ─────────────────
      // Checks actual file contents — cannot be bypassed by renaming
      const verifiedFiles: File[] = [];
      const rejectedNames: string[] = [];

      for (const file of mimeFiltered) {
        const isRealImage = await verifyImageMagicBytes(file);
        if (isRealImage) {
          verifiedFiles.push(file);
        } else {
          rejectedNames.push(file.name);
        }
      }

      if (rejectedNames.length > 0) {
        window.alert(
          `The following file${rejectedNames.length > 1 ? "s" : ""} could not be verified as valid images and were skipped:\n\n${rejectedNames.join("\n")}`,
        );
      }

      if (verifiedFiles.length === 0) {
        input.value = "";
        setUploading(false);
        return;
      }

      // ── Step 3: size check ───────────────────────────────
      const MAX_MB = 15;
      const oversized = verifiedFiles.filter(
        (f) => f.size > MAX_MB * 1024 * 1024,
      );
      if (oversized.length > 0) {
        window.alert(
          `${oversized.length} file${oversized.length > 1 ? "s" : ""} exceed the ${MAX_MB}MB limit and were skipped: ${oversized.map((f) => f.name).join(", ")}`,
        );
      }
      const safeFiles = verifiedFiles.filter(
        (f) => f.size <= MAX_MB * 1024 * 1024,
      );

      if (safeFiles.length === 0) {
        input.value = "";
        setUploading(false);
        return;
      }

      // ── Step 4: upload ───────────────────────────────────
      setUploading(true);
      setUploadProgress({ total: safeFiles.length, completed: 0 });
      try {
        const currentSession = await supabase.auth.getSession();
        const sess = currentSession.data.session;
        if (!sess) return;

        const currentOwner = fileInputRef.current?._ownerId ?? sess.user.id;

        await Promise.all(
          safeFiles.map(async (file: File) => {
            const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
            const uri = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            await uploadToS3(currentOwner, collectionName, fileName, uri, 0, 0);
            setUploadProgress((prev) => ({
              ...prev,
              completed: prev.completed + 1,
            }));
          }),
        );

        // Bump immediately once the uploads themselves succeed — not only
        // if the list-photos refresh below also succeeds. Otherwise a
        // network hiccup on just this refresh (uploads already landed
        // server-side) would leave the cache's version un-bumped, so a
        // LATER visit in this session could still hydrate the pre-upload
        // cached photo list, silently missing what was just uploaded.
        bumpCollectionVersion(currentOwner, collectionName);

        const { data, error } = await supabase.functions.invoke("list-photos", {
          body: { userId: currentOwner, collectionName, includeUrls: true },
        });
        if (!error) {
          const photoList = (data?.photos || []).filter(
            (p: any) => p.Key && !p.Key.includes("/thumbs/"),
          );
          const mapped: Photo[] = photoList.map((p: any) => ({
            key: p.Key,
            url: p.url,
            thumbUrl: p.thumbUrl ?? p.url,
            width: p.metadata?.width ?? 1,
            height: p.metadata?.height ?? 1,
            caption: p.caption ?? undefined,
          }));
          setPhotos(mapped);
          preloadImages(mapped);
          setCachedCollectionPhotos(currentOwner, collectionName, mapped);
        }
      } catch (error: any) {
        console.error("Web upload error:", error.message);
        window.alert(
          "Upload failed. Please check your connection and try again.",
        );
      } finally {
        setUploading(false);
        setUploadProgress({ total: 0, completed: 0 });
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

  // `nameOverride` exists solely for the rename flow — the route's `id`
  // param may not actually cause this screen to remount (expo-router
  // reuses the same instance across param changes on the same route),
  // so `collectionName` in the closure below can still be the OLD name
  // for a moment right after a rename succeeds. Passing the fresh name
  // explicitly avoids fetching photos from a prefix that no longer
  // exists (rename-collection has already deleted the old one).
  async function fetchPhotos(
    currentSession: Session,
    ownerId?: string,
    nameOverride?: string,
  ) {
    const owner = ownerId ?? effectiveOwnerId ?? currentSession.user.id;
    const name = nameOverride ?? collectionName;
    try {
      const { data, error } = await supabase.functions.invoke("list-photos", {
        body: { userId: owner, collectionName: name, includeUrls: true },
      });
      if (error) {
        // A 403 here specifically means access was revoked out from under
        // an actively open (or deep-linked) shared collection — see
        // unshareCollection in utils/sharing.ts, which just deletes the
        // shared_collections row with no push notice to the viewer. This
        // is the "reactively discover mid-session" path; the home screen
        // handles the "revoked while not looking at it" path separately.
        // Whatever's currently in `photos` state is no longer authorized
        // to sit in this device's disk cache, so evict it before bouncing
        // back — otherwise the bytes just linger indefinitely.
        const status = (error as any)?.context?.status;
        if (status === 403) {
          const staleKeys = photos.map((p) => p.key);
          if (staleKeys.length > 0) {
            evictPhotosFromCache(staleKeys).catch(() => {});
          }
          // Force a real refetch on the home screen instead of letting
          // it skip via its own freshness check — otherwise a revoked
          // collection could still show there. Also drop this
          // collection's own cached photos outright (not just bump the
          // version) so a stray revisit — browser back/forward, a
          // stale deep link — can't hydrate from cache without ever
          // re-checking the server, which is the only way revocation
          // actually gets detected here. See utils/collectionsCache.ts.
          dropCollectionCache(owner, name);
          // Plain Alert.alert() here would be silently invisible on web
          // (react-native-web's implementation is a no-op) — see
          // utils/alert.ts. This 403 path runs on every platform (unlike
          // the native-only upload alerts elsewhere in this file), so it
          // needs the cross-platform version.
          showAlert(
            "Access removed",
            "The owner has stopped sharing this collection with you.",
          );
          router.replace("/");
          return;
        }
        throw new Error(error.message);
      }

      const photoList = (data?.photos || []).filter(
        (p: any) => p.Key && !p.Key.includes("/thumbs/"),
      );

      if (photoList.length === 0) {
        setPhotos([]);
        setCachedCollectionPhotos(owner, name, []);
        return;
      }

      const mapped: Photo[] = photoList.map((p: any) => ({
        key: p.Key,
        url: p.url,
        thumbUrl: p.thumbUrl ?? p.url,
        width: p.metadata?.width ?? 1,
        height: p.metadata?.height ?? 1,
        caption: p.caption ?? undefined,
      }));

      setPhotos(mapped);
      preloadImages(mapped);
      setCachedCollectionPhotos(owner, name, mapped);
    } catch (error: any) {
      console.error("fetchPhotos error:", error.message);
      showAlert("Error", "Could not load photos. Please try again.");
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

  // ── Why goToNext/goToPrev are routed through refs ────────────
  // PanResponder.create() is only ever called once (it lives inside
  // useRef's initializer), so its handlers permanently close over
  // whichever goToNext/goToPrev — and by extension, whichever `photos`
  // array — existed on that very first render. `photos` starts out as
  // `[]` before the fetch resolves, so the ORIGINAL goToNext saw
  // `photos.length === 0` and its bounds check (`prev >= photos.length - 1`)
  // was permanently `prev >= -1`, i.e. always true — silently no-opping
  // forever. goToPrev's bounds check only depends on `prev`, not on
  // `photos.length`, so it was never affected — which is exactly why
  // swiping backward kept working while swiping forward never did.
  // Stashing the latest functions in refs (updated every render) and
  // having the responder call through `.current` fixes this without
  // having to recreate the PanResponder itself.
  const goToNextRef = useRef(goToNext);
  const goToPrevRef = useRef(goToPrev);
  goToNextRef.current = goToNext;
  goToPrevRef.current = goToPrev;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 10,
      onPanResponderMove: (_, gs) => {
        swipeX.setValue(gs.dx);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dx < -80) goToNextRef.current();
        else if (gs.dx > 80) goToPrevRef.current();
        Animated.spring(swipeX, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  function checkPhotoLimit(
    subStatus: SubscriptionStatus | null,
    photoCount: number,
    onAllowed: () => void,
  ): void {
    const isActive = subStatus?.isActive ?? false;
    const maxPhotos = subStatus?.limits?.maxPhotosPerCollection ?? 10;

    if (photoCount < maxPhotos) {
      onAllowed();
      return;
    }

    if (isActive) {
      showToast(
        `You've reached the ${maxPhotos} photo limit for this collection.`,
        "📸",
        "Delete some photos to add more.",
        false,
      );
      return;
    }

    if (!isOwner) {
      showToast(
        `This collection has reached the ${maxPhotos} photo limit.`,
        "📸",
        "Subscribe to Mems to add more photos.",
        true,
      );
      return;
    }

    pendingUploadRef.current = onAllowed;
    setPaywallReason("photos");
    setShowPaywall(true);
  }

  async function uploadPhoto() {
    let subStatus = subscriptionStatus;
    if (!subStatus) {
      subStatus = await checkSubscription();
      setSubscriptionStatus(subStatus);
    }

    const realPhotos = photos.filter((p) => !p.key.includes("/thumbs/"));

    // ── Web upload ────────────────────────────────────────
    if (Platform.OS === "web") {
      checkPhotoLimit(subStatus, realPhotos.length, () => {
        if (fileInputRef.current) fileInputRef.current.click();
      });
      return;
    }

    // ── Native upload ─────────────────────────────────────
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

    checkPhotoLimit(subStatus, realPhotos.length, async () => {
      setUploading(true);
      setUploadProgress({ total: result.assets.length, completed: 0 });
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
            setUploadProgress((prev) => ({
              ...prev,
              completed: prev.completed + 1,
            }));
          }),
        );
        bumpCollectionVersion(uploadOwnerId, collectionName);
        await fetchPhotos(session);
      } catch (error: any) {
        // Log full error internally, show generic message to user
        console.error("Upload error:", error.message);
        Alert.alert("Upload failed", "Something went wrong. Please try again.");
      } finally {
        setUploading(false);
        setUploadProgress({ total: 0, completed: 0 });
      }
    });
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
      const owner = effectiveOwnerId ?? session?.user.id;
      if (owner) {
        bumpCollectionVersion(owner, collectionName);
        // Best-effort (neither call throws on its own) — the photo itself
        // is already gone from S3 at this point, so this is purely
        // cleanup, not something that should block the delete the user
        // asked for.
        deletePhotoCaption(owner, photo.key);
        deletePhotoSharesForPhoto(owner, photo.key);
      }
      if (session) await fetchPhotos(session);
    } catch (error: any) {
      console.error("Delete error:", error.message);
      if (Platform.OS === "web") {
        window.alert("Could not delete photo. Please try again.");
      } else {
        Alert.alert("Delete failed", "Something went wrong. Please try again.");
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
      // The collection is gone outright, not just changed — drop its
      // cache entry entirely rather than just bumping its version.
      if (session) dropCollectionCache(session.user.id, collectionName);
      router.replace("/");
    } catch (error: any) {
      console.error("Delete collection error:", error.message);
      if (Platform.OS === "web") {
        window.alert("Could not delete collection. Please try again.");
      } else {
        Alert.alert("Error", "Something went wrong. Please try again.");
      }
      setLoading(false);
    }
  }

  async function handleRenameCollection() {
    const trimmed = renameInput.trim();
    if (!trimmed) {
      const msg = "Please enter a collection name.";
      Platform.OS === "web"
        ? window.alert(msg)
        : Alert.alert("Name required", msg);
      return;
    }
    if (trimmed === collectionName) {
      setShowRenameModal(false);
      return;
    }

    setRenaming(true);
    try {
      const finalName = await renameCollection(collectionName, trimmed);
      // The OLD name no longer exists as a collection — drop its cache
      // entry outright (the new name's entry gets written fresh below,
      // by the explicit fetchPhotos call, same as it always did).
      const renameOwner = effectiveOwnerId ?? session?.user.id;
      if (renameOwner) dropCollectionCache(renameOwner, collectionName);
      setShowRenameModal(false);

      // Load photos from the new prefix explicitly — expo-router may
      // reuse this same screen instance for the URL change below rather
      // than remounting it, so we can't rely on navigation alone to
      // trigger a refetch (see the comment on fetchPhotos).
      if (session) {
        await fetchPhotos(session, effectiveOwnerId ?? session.user.id, finalName);
      }
      await loadShares(finalName);

      // Update the URL too, so the address bar, refreshes, and the
      // back/forward history all point at the collection's real name.
      const ownerQuery = ownerIdParam
        ? `?ownerId=${encodeURIComponent(ownerIdParam)}`
        : "";
      router.replace(
        `/collection/${encodeURIComponent(finalName)}${ownerQuery}` as any,
      );
    } catch (error: any) {
      console.error("Rename collection error:", error.message);
      const msg =
        error.message || "Could not rename collection. Please try again.";
      Platform.OS === "web" ? window.alert(msg) : Alert.alert("Error", msg);
    } finally {
      setRenaming(false);
    }
  }

  function openDateModal() {
    setEditingDateIso(memoryDate ?? null);
    setShowDateModal(true);
  }

  async function handleSaveMemoryDate() {
    if (!session) return;

    setSavingDate(true);
    try {
      await setCollectionMemoryDate(
        effectiveOwnerId ?? session.user.id,
        collectionName,
        editingDateIso,
      );
      setMemoryDate(editingDateIso);
      setShowDateModal(false);
    } catch (error: any) {
      console.error("Save memory date error:", error.message);
      const msg =
        error.message || "Could not save the date. Please try again.";
      Platform.OS === "web" ? window.alert(msg) : Alert.alert("Error", msg);
    } finally {
      setSavingDate(false);
    }
  }

  async function handleClearMemoryDate() {
    if (!session) return;
    setSavingDate(true);
    try {
      await setCollectionMemoryDate(
        effectiveOwnerId ?? session.user.id,
        collectionName,
        null,
      );
      setMemoryDate(null);
      setShowDateModal(false);
    } catch (error: any) {
      console.error("Clear memory date error:", error.message);
      const msg =
        error.message || "Could not clear the date. Please try again.";
      Platform.OS === "web" ? window.alert(msg) : Alert.alert("Error", msg);
    } finally {
      setSavingDate(false);
    }
  }

  // Same reasoning as fetchPhotos' nameOverride — right after a rename,
  // the closure's `collectionName` can still briefly be the old name.
  async function loadShares(nameOverride?: string) {
    if (!session) return;
    try {
      const emails = await getCollectionShares(
        session.user.id,
        nameOverride ?? collectionName,
      );
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
      // Was previously always replaced with a generic "Could not share
      // collection" message here, regardless of what actually failed —
      // which meant shareCollection()'s own specific, useful errors (you
      // can't share with yourself; this is already shared with that
      // email) were thrown away right along with genuine unexpected
      // failures, and a user's screenshot of the alert could never tell
      // us which one they'd hit. Showing the real message fixes that for
      // the common cases; Sentry.captureException covers the rest —
      // this screen has no explicit error reporting anywhere else, so an
      // unexpected failure here previously left no trace once the
      // console log scrolled away.
      console.error("Share error:", error.message);
      Sentry.captureException(error, {
        tags: { action: "share_collection" },
        extra: { collectionName },
      });
      const msg =
        error.message || "Could not share collection. Please try again.";
      showAlert("Error", msg);
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
      console.error("Unshare error:", error.message);
      showAlert("Error", "Could not remove access. Please try again.");
    }
  }

  // ── Individual photo sharing ─────────────────────────────────────
  // Mirrors loadShares/handleShare/handleUnshare above almost exactly,
  // scoped to sharePhotoTargetKey instead of the whole collection.
  function openSharePhotoModal(photo: Photo) {
    setSharePhotoTargetKey(photo.key);
    setSharePhotoEmail("");
    setShowSharePhotoModal(true);
    loadPhotoShares(photo.key);
  }

  async function loadPhotoShares(photoKey: string) {
    if (!session) return;
    try {
      const emails = await getPhotoShares(session.user.id, photoKey);
      setPhotoSharedWith(emails);
    } catch (error: any) {
      console.warn("loadPhotoShares error:", error.message);
    }
  }

  async function handleSharePhoto() {
    if (!sharePhotoEmail.trim()) {
      showAlert("Email required", "Please enter an email address.");
      return;
    }
    if (!session?.user?.email || !sharePhotoTargetKey) return;
    setSharingPhoto(true);
    try {
      await sharePhoto(
        session.user.id,
        session.user.email,
        collectionName,
        sharePhotoTargetKey,
        sharePhotoEmail.trim(),
      );
      const email = sharePhotoEmail.trim();
      setSharePhotoEmail("");
      setShowSharePhotoModal(false);
      await loadPhotoShares(sharePhotoTargetKey);
      setTimeout(() => {
        showAlert("Shared!", `Photo shared with ${email}`);
      }, 300);
    } catch (error: any) {
      // Same reasoning as handleShare's catch above — surface
      // sharePhoto()'s own specific errors (already shared, can't share
      // with yourself) instead of a generic message, and get Sentry
      // coverage for anything unexpected.
      console.error("Share photo error:", error.message);
      Sentry.captureException(error, {
        tags: { action: "share_photo" },
        extra: { collectionName, photoKey: sharePhotoTargetKey },
      });
      const msg = error.message || "Could not share photo. Please try again.";
      showAlert("Error", msg);
    } finally {
      setSharingPhoto(false);
    }
  }

  async function handleUnsharePhoto(email: string) {
    if (!sharePhotoTargetKey) return;
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
      await unsharePhoto(session!.user.id, sharePhotoTargetKey, email);
      await loadPhotoShares(sharePhotoTargetKey);
    } catch (error: any) {
      console.error("Unshare photo error:", error.message);
      showAlert("Error", "Could not remove access. Please try again.");
    }
  }

  // Deterministic tilt per photo — same every render, no jitter
  // Alternates between slight left and right tilts for a scattered feel
  const TILTS = [-2.5, 1.8, -1.2, 2.8, -2.0, 1.5, -3.0, 2.2];

  const memoryDateInfo = getMemoryDateInfo(memoryDate);

  const renderPhoto = (item: Photo, index: number) => {
    const hasDimensions = item.width !== 1 || item.height !== 1;
    const aspectRatio = hasDimensions ? item.height / item.width : 1;

    // Polaroid photo area — square-ish, slightly portrait
    const photoWidth = COLUMN_WIDTH - 16; // inner image width inside the polaroid
    const photoHeight = hasDimensions
      ? Math.min(photoWidth * aspectRatio, photoWidth * 1.3) // cap tall images
      : photoWidth;

    const POLAROID_PADDING = 8; // white border on sides and top
    const POLAROID_BOTTOM = 32; // larger white space at bottom for the caption area
    const tilt = TILTS[index % TILTS.length];

    return (
      <TouchableOpacity
        key={item.key}
        style={[
          styles.polaroidWrapper,
          { transform: [{ rotate: `${tilt}deg` }] },
        ]}
        onPress={() => openPhoto(photos.indexOf(item))}
        activeOpacity={0.88}
      >
        {/* Polaroid card */}
        <View style={styles.polaroidCard}>
          {/* Photo area */}
          <View
            style={[
              styles.polaroidPhotoArea,
              { width: photoWidth, height: photoHeight },
            ]}
          >
            <View style={styles.photoPlaceholder} />
            <Image
              source={{
                uri: item.thumbUrl ?? item.url,
                // Stable S3 key rather than the presigned URL — the URL's
                // signature/expiry changes every list-photos call even when
                // the photo hasn't, which would make the disk cache miss on
                // every fresh screen load. Must match whichever of
                // thumbUrl/url is actually being rendered above (thumb and
                // full-res are different bytes at different S3 keys).
                // Note: cacheKey lives on the `source` object itself, not
                // as a top-level <Image> prop.
                cacheKey: item.thumbUrl
                  ? deriveThumbKey(item.key)
                  : item.key,
              }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={item.key}
              transition={{ duration: 200, effect: "cross-dissolve" }}
            />
          </View>
          {/* Polaroid caption strip — the white space below the photo */}
          <View style={styles.polaroidCaption}>
            <View style={styles.polaroidCaptionLine} />
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <AlbumBackground style={styles.container}>
      {/* Header + collection name banner + avatar strip, as one unit —
          see chromeHeight's comment above for why they're grouped and
          measured together. Absolutely positioned so it overlays the top
          of the photo grid instead of taking flex space (see
          styles.headerFloating), which is what lets it slide fully
          off-screen without leaving a blank gap — the grid below has its
          own animated top margin (gridMarginTop) that shrinks in lockstep
          to fill exactly that gap as this slides away. */}
      <Animated.View
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          if (Math.abs(h - chromeHeight) > 0.5) setChromeHeight(h);
        }}
        style={[
          styles.headerFloating,
          { transform: [{ translateY: chromeTranslateY }] },
        ]}
      >
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: Platform.OS === "web" ? 16 : insets.top + 6 },
        ]}
      >
        <View style={styles.headerLeft}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => {
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
            onPress={() => {
              // Prefer back() over replace("/") — this collection is
              // always reached by pushing from home, so back() reveals
              // the SAME still-mounted home instance (instant, cache
              // intact) rather than replace()'s unmount-and-remount
              // (see utils/collectionsCache.ts's getCachedHomeCollections
              // comment for why that used to defeat the freshness cache
              // entirely). Falls back to replace() only for the rare
              // case this screen was reached with no history at all
              // (e.g. a direct/deep link).
              if (router.canGoBack()) {
                router.back();
              } else {
                router.replace("/");
              }
            }}
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
        {/* Title (with its rename pencil right beside it) wraps freely on
            the left; the memory-date badge sits on the right, top-aligned
            with the name via this row's `alignItems: flex-start` — both
            groups start at the same vertical position regardless of how
            many lines the title wraps to. */}
        <View style={styles.collectionBannerHeaderRow}>
          <View style={styles.collectionBannerTitleRow}>
            <Text style={styles.collectionBannerTitle} numberOfLines={3}>
              {collectionName}
            </Text>
            {isOwner && (
              <TouchableOpacity
                onPress={() => {
                  setRenameInput(collectionName);
                  setShowRenameModal(true);
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={styles.renameIconButton}
              >
                <Ionicons name="pencil" size={14} color="#999" />
              </TouchableOpacity>
            )}
          </View>

          {/* Memory date — the "wow" moment. A collection with a date set
              gets a warm gradient badge showing how long ago it was (with
              a special treatment if today happens to be the anniversary);
              without one, owners get a low-key invitation to add one. */}
          {memoryDateInfo ? (
            <TouchableOpacity
              activeOpacity={isOwner ? 0.85 : 1}
              onPress={isOwner ? openDateModal : undefined}
              style={styles.memoryBadgeWrapper}
            >
              <LinearGradient
                colors={
                  memoryDateInfo.isAnniversaryToday
                    ? ["#f59e0b", "#ec4899"]
                    : ["#fef3c7", "#fde8d7"]
                }
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.memoryBadge}
              >
                <Text style={styles.memoryBadgeIcon}>
                  {memoryDateInfo.isAnniversaryToday ? "✨" : "📅"}
                </Text>
                <View style={styles.memoryBadgeTextBlock}>
                  <Text
                    style={[
                      styles.memoryBadgeRelative,
                      memoryDateInfo.isAnniversaryToday &&
                        styles.memoryBadgeTextSpecial,
                    ]}
                    numberOfLines={1}
                  >
                    {memoryDateInfo.isAnniversaryToday
                      ? `On this day, ${memoryDateInfo.relative}`
                      : memoryDateInfo.relative}
                  </Text>
                  <Text
                    style={[
                      styles.memoryBadgeFull,
                      memoryDateInfo.isAnniversaryToday &&
                        styles.memoryBadgeFullSpecial,
                    ]}
                    numberOfLines={1}
                  >
                    {IS_DESKTOP_WEB ? ` · ${memoryDateInfo.full}` : memoryDateInfo.full}
                  </Text>
                </View>
              </LinearGradient>
            </TouchableOpacity>
          ) : (
            isOwner && (
              <TouchableOpacity
                style={styles.addDateButton}
                onPress={openDateModal}
                activeOpacity={0.75}
              >
                <Ionicons name="calendar-outline" size={13} color="#999" />
                <Text style={styles.addDateButtonText}>Add a memory date</Text>
              </TouchableOpacity>
            )
          )}
        </View>
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
      </Animated.View>

      {/* Photo Grid — animated top margin mirrors the chrome block's
          height so the grid expands to fill the space it vacates (see
          the comment above the header block). */}
      <Animated.View style={{ flex: 1, marginTop: gridMarginTop }}>
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
          onScroll={handleGridScroll}
          scrollEventThrottle={16}
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
      </Animated.View>

      {/* Full Screen Photo Viewer */}
      <Modal
        visible={selectedPhotoIndex !== null}
        transparent={false}
        animationType="fade"
        statusBarTranslucent
      >
        <AlbumBackground style={styles.fullScreenViewer}>
          {/* Native — FlatList with paging — rendered first */}
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
              renderItem={({ item, index }) => {
                // Every page renders the SAME component (PhotoFlipCard),
                // active or not — see INERT_FLIP_ANIM's comment above for
                // why. Only the active page gets the real, shared
                // flipAnim/isFlipped/isOwner; inactive pages get the inert
                // anim (permanently front-facing) and isOwner=false (so
                // their caption strip stays non-interactive, matching the
                // old plain-card behavior) and no-op handlers, since
                // there's no sensible target for "flip"/"edit caption" on
                // a page that isn't the one currently being viewed.
                const active = index === selectedPhotoIndex;
                return (
                  <AlbumBackground style={styles.fullScreenPage}>
                    <PhotoFlipCard
                      item={item}
                      isOwner={active && isOwner}
                      isFlipped={active && isFlipped}
                      flipAnim={active ? flipAnim : INERT_FLIP_ANIM}
                      onTapCaption={
                        active ? () => openCaptionModal(item) : () => {}
                      }
                      onFlip={active ? () => toggleFlip() : () => {}}
                    />
                  </AlbumBackground>
                );
              }}
              windowSize={5}
              maxToRenderPerBatch={3}
              initialNumToRender={3}
            />
          )}

          {/* Web (including mobile web browsers) — polaroid-framed image
              over the same warm background as the collection grid, with
              drag-to-swipe via the panResponder declared above. Position
              among the other photos is shown by the dots below the image
              (see pageDots) rather than floating arrows — no controls
              overlaid on the photo itself. Swipe stays active even while
              flipped — the back face used to hold an inline TextInput
              that a horizontal-drag gesture could swallow taps from, but
              that's gone now (editing happens through the caption modal
              instead), and onMoveShouldSetPanResponder only claims
              genuinely horizontal drags (Math.abs(dx) > 10), so it
              doesn't fight the back face's own vertical caption
              ScrollView either. The per-photo flip-reset effect above
              (keyed on selectedPhotoIndex) means swiping to a new photo
              while flipped still lands on that photo's FRONT, not its
              back. */}
          {selectedPhotoIndex !== null && Platform.OS === "web" && (
            <View style={styles.webViewerWrapper}>
              <Animated.View
                style={[
                  StyleSheet.absoluteFill,
                  styles.webImageDragLayer,
                  { transform: [{ translateX: swipeX }] },
                ]}
                {...panResponder.panHandlers}
              >
                <PhotoFlipCard
                  item={photos[selectedPhotoIndex]}
                  isOwner={isOwner}
                  isFlipped={isFlipped}
                  flipAnim={flipAnim}
                  onTapCaption={() =>
                    openCaptionModal(photos[selectedPhotoIndex])
                  }
                  onFlip={() => toggleFlip()}
                />
              </Animated.View>
            </View>
          )}

          {/* Controls overlay — rendered LAST so always on top of FlatList */}
          <View style={styles.viewerControls} pointerEvents="box-none">
            <TouchableOpacity
              style={styles.fullScreenClose}
              onPress={() => setSelectedPhotoIndex(null)}
              hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
            >
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>

            {/* pointerEvents="none" — purely informational, but as a
                full-width (left:0/right:0) absolutely-positioned View it
                would otherwise still intercept taps anywhere in its row,
                including on top of fullScreenClose sitting in the same
                vertical band — the exact bug that made close untappable
                on the shared-photo viewer while flip (painted after this)
                stayed clickable. */}
            {selectedPhotoIndex !== null && (
              <View style={styles.fullScreenCounter} pointerEvents="none">
                <Text style={styles.fullScreenCounterText}>
                  {selectedPhotoIndex + 1} / {photos.length}
                </Text>
              </View>
            )}

            {/* Flip trigger — same top-right strip as close, just to its
                left, rather than a floating control near the photo itself
                (same reasoning as fullScreenDelete below: a fixed safe
                zone never overlaps the image regardless of its size). A
                plain rounded arrow rather than the camera-reverse glyph —
                that one reads as a camera-specific control (it has an
                actual little camera body drawn into it), which doesn't
                fit a photo VIEWER at all. */}
            {selectedPhotoIndex !== null && (
              <TouchableOpacity
                style={styles.fullScreenFlip}
                onPress={() => toggleFlip()}
                hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
              >
                <Ionicons name="reload-outline" size={22} color="#fff" />
              </TouchableOpacity>
            )}

            {/* Small icon button in the same fixed top strip as close —
                deliberately NOT a floating overlay near the bottom of the
                image anymore. That used to be a wide red pill positioned by
                a flat distance from the screen edge, which put it on top of
                the actual photo for some aspect ratios/screen sizes (the
                polaroid card's height varies per photo, but the button's
                position didn't). The top strip is a fixed safe zone that
                never overlaps the image regardless of its size. */}
            {isOwner && selectedPhotoIndex !== null && (
              <TouchableOpacity
                style={styles.fullScreenDelete}
                onPress={() => {
                  const photo = photos[selectedPhotoIndex];
                  if (photo) deletePhoto(photo);
                }}
                hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
              >
                <Ionicons name="trash-outline" size={20} color="#fff" />
              </TouchableOpacity>
            )}

            {/* Share THIS photo (not the whole collection — that's the
                Share button in the header banner above the grid) — sits
                just right of delete in the same top-left cluster, same
                44px-width + 12px-gap spacing as the flip/close pair on
                the right. Owner-only, same gate as delete. */}
            {isOwner && selectedPhotoIndex !== null && (
              <TouchableOpacity
                style={styles.fullScreenSharePhoto}
                onPress={() => {
                  const photo = photos[selectedPhotoIndex];
                  if (photo) openSharePhotoModal(photo);
                }}
                hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
              >
                <Ionicons
                  name="share-social-outline"
                  size={20}
                  color="#fff"
                />
              </TouchableOpacity>
            )}

            {/* Pagination dots — the position indicator now that there are
                no floating arrows. One dot per photo regardless of
                collection size, kept to a single scrollable line (rather
                than wrapping onto several) so a large collection can't
                grow tall enough to climb up over the photo — the effect
                above keeps the active dot auto-centered as you swipe. */}
            {selectedPhotoIndex !== null && photos.length > 1 && (
              <ScrollView
                ref={dotsScrollRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.pageDots}
                contentContainerStyle={styles.pageDotsContent}
              >
                {photos.map((photo, i) => (
                  <View
                    key={photo.key}
                    style={
                      i === selectedPhotoIndex
                        ? styles.pageDotActive
                        : styles.pageDot
                    }
                  />
                ))}
              </ScrollView>
            )}
          </View>

          {/* Caption Modal — used both to add a new caption and to edit or
              delete an existing one; see openCaptionModal/handleSaveCaption/
              handleDeleteCaption above. Deliberately nested HERE, inside the
              photo viewer's own <Modal>, rather than as a sibling overlay
              further down the tree (that's where the Memory Date/Share
              modals live, and it's fine for them — they're opened from the
              collection GRID, which has nothing else stacked on top of it).
              This modal, though, is opened from WITHIN the full-screen
              photo viewer, which is itself a <Modal> — React Native's
              (and react-native-web's) Modal renders in its own top-level
              layer above the normal view tree, so a second overlay placed
              outside this Modal would paint BEHIND it: technically mounted,
              but invisible and untappable, which is exactly the "nothing
              opens" silent failure. Living inside this same Modal sidesteps
              that entirely — no nested <Modal> needed, just a plain
              absolutely-positioned overlay that already stacks above
              everything else in here. */}
          {showCaptionModal && (
            <View style={styles.shareWebOverlay}>
              <TouchableOpacity
                style={styles.shareOverlayBackdrop}
                activeOpacity={1}
                onPress={() => !savingCaption && setShowCaptionModal(false)}
              >
                <TouchableOpacity
                  activeOpacity={1}
                  style={[
                    styles.shareOverlayCard,
                    IS_DESKTOP_WEB && styles.desktopModalCard,
                  ]}
                  onPress={(e) => e.stopPropagation()}
                >
                  <View style={styles.shareModalHeader}>
                    <Text style={styles.shareModalTitle}>Caption</Text>
                    <TouchableOpacity
                      onPress={() => setShowCaptionModal(false)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.shareModalClose}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    style={styles.captionModalInput}
                    value={captionModalDraft}
                    onChangeText={setCaptionModalDraft}
                    placeholder="Write a caption…"
                    placeholderTextColor="#999"
                    multiline
                    maxLength={170}
                    autoFocus
                  />
                  <Text style={styles.captionModalCounter}>
                    {captionModalDraft.length}/170
                  </Text>
                  <TouchableOpacity
                    style={[
                      styles.primaryModalButton,
                      savingCaption && { opacity: 0.6 },
                    ]}
                    onPress={handleSaveCaption}
                    disabled={savingCaption}
                  >
                    {savingCaption ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <Text style={styles.primaryModalButtonText}>
                        Save caption
                      </Text>
                    )}
                  </TouchableOpacity>
                  {captionModalOriginal && (
                    <TouchableOpacity
                      style={styles.clearDateButton}
                      onPress={handleDeleteCaption}
                      disabled={savingCaption}
                    >
                      <Text style={styles.clearDateButtonText}>
                        Delete caption
                      </Text>
                    </TouchableOpacity>
                  )}
                </TouchableOpacity>
              </TouchableOpacity>
            </View>
          )}

          {/* Share Photo — same reasoning as the caption modal just above:
              this has to live INSIDE the photo viewer's own Modal, not as
              a sibling after it closes. It's opened from a button in this
              same viewer's controls overlay, so anything outside this
              Modal would again paint behind it — invisible and untappable
              until the viewer closes, which is exactly the bug this
              mirrors and fixes (see showCaptionModal's comment for the
              full explanation). No web/native branch needed here either,
              for the same reason. */}
          {showSharePhotoModal && (
            <View style={styles.shareWebOverlay}>
              <TouchableOpacity
                style={styles.shareOverlayBackdrop}
                activeOpacity={1}
                onPress={() => setShowSharePhotoModal(false)}
              >
                <TouchableOpacity
                  activeOpacity={1}
                  style={[
                    styles.shareOverlayCard,
                    IS_DESKTOP_WEB && styles.desktopModalCard,
                  ]}
                  onPress={(e) => e.stopPropagation()}
                >
                  <View style={styles.shareModalHeader}>
                    <Text style={styles.shareModalTitle}>Share Photo</Text>
                    <TouchableOpacity
                      onPress={() => setShowSharePhotoModal(false)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.shareModalClose}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.sharePhotoHint}>
                    Only this photo will be shared — they'll also see it's
                    from your "{collectionName}" album, but won't be able
                    to browse the rest of it.
                  </Text>
                  <View style={styles.shareInputRow}>
                    <TextInput
                      style={styles.shareInput}
                      placeholder="Enter email to share"
                      placeholderTextColor="#999"
                      value={sharePhotoEmail}
                      onChangeText={setSharePhotoEmail}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <TouchableOpacity
                      style={[
                        styles.shareSubmitButton,
                        sharingPhoto && { opacity: 0.6 },
                      ]}
                      onPress={handleSharePhoto}
                      disabled={sharingPhoto}
                    >
                      {sharingPhoto ? (
                        <ActivityIndicator color="#fff" size="small" />
                      ) : (
                        <Text style={styles.shareSubmitText}>Send</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                  {photoSharedWith.length > 0 && (
                    <View style={styles.shareList}>
                      <Text style={styles.shareListTitle}>Shared with</Text>
                      {photoSharedWith.map((email) => (
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
                          <Text
                            style={styles.shareListEmail}
                            numberOfLines={1}
                          >
                            {email}
                          </Text>
                          <TouchableOpacity
                            style={styles.removeButton}
                            onPress={() => handleUnsharePhoto(email)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Text style={styles.removeButtonText}>
                              Remove
                            </Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  )}
                </TouchableOpacity>
              </TouchableOpacity>
            </View>
          )}
        </AlbumBackground>
      </Modal>

      {/* Share Modal */}
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
                style={[
                  styles.shareOverlayCard,
                  IS_DESKTOP_WEB && styles.desktopModalCard,
                ]}
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
                style={[
                  styles.shareOverlayCard,
                  IS_DESKTOP_WEB && styles.desktopModalCard,
                ]}
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

      {/* Rename Modal */}
      {showRenameModal &&
        (Platform.OS === "web" ? (
          <View style={styles.shareWebOverlay}>
            <TouchableOpacity
              style={styles.shareOverlayBackdrop}
              activeOpacity={1}
              onPress={() => !renaming && setShowRenameModal(false)}
            >
              <TouchableOpacity
                activeOpacity={1}
                style={styles.shareOverlayCard}
                onPress={(e) => e.stopPropagation()}
              >
                <View style={styles.shareModalHeader}>
                  <Text style={styles.shareModalTitle}>Rename Collection</Text>
                  <TouchableOpacity
                    onPress={() => setShowRenameModal(false)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.shareModalClose}>✕</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.shareInputRow}>
                  <TextInput
                    style={styles.shareInput}
                    placeholder="Collection name"
                    placeholderTextColor="#999"
                    value={renameInput}
                    onChangeText={setRenameInput}
                    autoFocus
                    maxLength={80}
                    returnKeyType="done"
                    onSubmitEditing={handleRenameCollection}
                  />
                  <TouchableOpacity
                    style={[
                      styles.shareSubmitButton,
                      renaming && { opacity: 0.6 },
                    ]}
                    onPress={handleRenameCollection}
                    disabled={renaming}
                  >
                    {renaming ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <Text style={styles.shareSubmitText}>Save</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            </TouchableOpacity>
          </View>
        ) : (
          <Modal
            visible={showRenameModal}
            transparent
            animationType="fade"
            statusBarTranslucent
            onRequestClose={() => setShowRenameModal(false)}
          >
            <TouchableOpacity
              style={styles.shareOverlayBackdrop}
              activeOpacity={1}
              onPress={() => !renaming && setShowRenameModal(false)}
            >
              <TouchableOpacity
                activeOpacity={1}
                style={styles.shareOverlayCard}
                onPress={(e) => e.stopPropagation()}
              >
                <View style={styles.shareModalHeader}>
                  <Text style={styles.shareModalTitle}>Rename Collection</Text>
                  <TouchableOpacity
                    onPress={() => setShowRenameModal(false)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.shareModalClose}>✕</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.shareInputRow}>
                  <TextInput
                    style={styles.shareInput}
                    placeholder="Collection name"
                    placeholderTextColor="#999"
                    value={renameInput}
                    onChangeText={setRenameInput}
                    autoFocus
                    maxLength={80}
                    returnKeyType="done"
                    onSubmitEditing={handleRenameCollection}
                  />
                  <TouchableOpacity
                    style={[
                      styles.shareSubmitButton,
                      renaming && { opacity: 0.6 },
                    ]}
                    onPress={handleRenameCollection}
                    disabled={renaming}
                  >
                    {renaming ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <Text style={styles.shareSubmitText}>Save</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            </TouchableOpacity>
          </Modal>
        ))}

      {/* Memory Date Modal */}
      {showDateModal &&
        (Platform.OS === "web" ? (
          <View style={styles.shareWebOverlay}>
            <TouchableOpacity
              style={styles.shareOverlayBackdrop}
              activeOpacity={1}
              onPress={() => !savingDate && setShowDateModal(false)}
            >
              <TouchableOpacity
                activeOpacity={1}
                style={styles.shareOverlayCard}
                onPress={(e) => e.stopPropagation()}
              >
                <View style={styles.shareModalHeader}>
                  <Text style={styles.shareModalTitle}>Memory Date</Text>
                  <TouchableOpacity
                    onPress={() => setShowDateModal(false)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.shareModalClose}>✕</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.dateModalHint}>
                  When did these memories actually happen?
                </Text>
                <MemoryDatePicker
                  value={editingDateIso}
                  onChange={setEditingDateIso}
                />
                <TouchableOpacity
                  style={[
                    styles.primaryModalButton,
                    savingDate && { opacity: 0.6 },
                  ]}
                  onPress={handleSaveMemoryDate}
                  disabled={savingDate}
                >
                  {savingDate ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.primaryModalButtonText}>
                      Save date
                    </Text>
                  )}
                </TouchableOpacity>
                {memoryDate && (
                  <TouchableOpacity
                    style={styles.clearDateButton}
                    onPress={handleClearMemoryDate}
                    disabled={savingDate}
                  >
                    <Text style={styles.clearDateButtonText}>
                      Remove memory date
                    </Text>
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            </TouchableOpacity>
          </View>
        ) : (
          <Modal
            visible={showDateModal}
            transparent
            animationType="fade"
            statusBarTranslucent
            onRequestClose={() => setShowDateModal(false)}
          >
            <TouchableOpacity
              style={styles.shareOverlayBackdrop}
              activeOpacity={1}
              onPress={() => !savingDate && setShowDateModal(false)}
            >
              <TouchableOpacity
                activeOpacity={1}
                style={styles.shareOverlayCard}
                onPress={(e) => e.stopPropagation()}
              >
                <View style={styles.shareModalHeader}>
                  <Text style={styles.shareModalTitle}>Memory Date</Text>
                  <TouchableOpacity
                    onPress={() => setShowDateModal(false)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.shareModalClose}>✕</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.dateModalHint}>
                  When did these memories actually happen?
                </Text>
                <MemoryDatePicker
                  value={editingDateIso}
                  onChange={setEditingDateIso}
                />
                <TouchableOpacity
                  style={[
                    styles.primaryModalButton,
                    savingDate && { opacity: 0.6 },
                  ]}
                  onPress={handleSaveMemoryDate}
                  disabled={savingDate}
                >
                  {savingDate ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.primaryModalButtonText}>
                      Save date
                    </Text>
                  )}
                </TouchableOpacity>
                {memoryDate && (
                  <TouchableOpacity
                    style={styles.clearDateButton}
                    onPress={handleClearMemoryDate}
                    disabled={savingDate}
                  >
                    <Text style={styles.clearDateButtonText}>
                      Remove memory date
                    </Text>
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            </TouchableOpacity>
          </Modal>
        ))}

      {/* Toast */}
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
            {toast.subtext && (
              <Text style={styles.toastSubtext}>{toast.subtext}</Text>
            )}
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

      {/* Paywall Modal */}
      <PaywallModal
        visible={showPaywall}
        reason={paywallReason}
        currentLimit={subscriptionStatus?.limits?.maxPhotosPerCollection ?? 10}
        currentTier={
          subscriptionStatus?.isActive
            ? (subscriptionStatus.tier as any)
            : "free"
        }
        currentPaymentProvider={subscriptionStatus?.paymentProvider ?? null}
        currentGooglePlayPurchaseToken={
          subscriptionStatus?.googlePlayPurchaseToken ?? null
        }
        onSubscribed={async (_tier) => {
          const status = await checkSubscription();
          setSubscriptionStatus(status);
          setShowPaywall(false);
          if (pendingUploadRef.current) {
            const action = pendingUploadRef.current;
            pendingUploadRef.current = null;
            setTimeout(() => action(), 300);
          }
        }}
        onDismiss={() => {
          setShowPaywall(false);
          pendingUploadRef.current = null;
        }}
      />

      {/* Upload progress — shown while photos are being processed and uploaded */}
      <UploadProgressOverlay
        visible={uploading}
        total={uploadProgress.total}
        completed={uploadProgress.completed}
        label="Uploading photos"
      />
    </AlbumBackground>
  );
}

const styles = StyleSheet.create({
  // Texture itself supplies the background now (see AlbumBackground) —
  // this just needs to size the screen.
  container: { flex: 1 },

  // ── Header ────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingBottom: 12,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    minHeight: Platform.OS === "web" ? 64 : 56,
  },
  // Wraps the header + collectionBanner + avatarStrip block (see the
  // hide-on-scroll comment near chromeHeight's declaration) so it floats
  // over the grid instead of taking flex space.
  headerFloating: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
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

  // ── Banner ────────────────────────────────────────────────
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
  // Title (+ its rename pencil) on the left is allowed to wrap across
  // multiple lines; the date badge on the right stays top-aligned with the
  // name, since both this row and the title row use `alignItems: flex-start`.
  collectionBannerHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  collectionBannerTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    flex: 1,
    flexShrink: 1,
    gap: 6,
  },
  collectionBannerTitle: {
    fontSize: Platform.OS === "web" ? 22 : 20,
    fontWeight: "800",
    color: "#111",
    letterSpacing: -0.3,
    flexShrink: 1,
  },
  renameIconButton: {
    padding: 4,
    marginTop: Platform.OS === "web" ? 5 : 3,
    ...Platform.select({ web: { cursor: "pointer" } as any, default: {} }),
  },
  // ── Memory date badge ─────────────────────────────────────
  memoryBadgeWrapper: { maxWidth: "100%" },
  memoryBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: IS_DESKTOP_WEB ? 8 : 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.12,
        shadowRadius: 8,
      },
      android: { elevation: 3 },
      web: { boxShadow: "0 3px 14px rgba(0,0,0,0.08)" } as any,
    }),
  },
  memoryBadgeIcon: { fontSize: 20 },
  // On desktop web the relative + full date sit side by side on one line
  // (e.g. "3 months ago · July 12, 2026") to avoid extra vertical space in
  // the banner; on mobile they stay stacked since horizontal room is tighter.
  memoryBadgeTextBlock: IS_DESKTOP_WEB
    ? { flexShrink: 1, flexDirection: "row", alignItems: "baseline", gap: 0 }
    : { flexShrink: 1 },
  memoryBadgeRelative: { fontSize: 14, fontWeight: "800", color: "#92400e" },
  memoryBadgeTextSpecial: { color: "#fff" },
  memoryBadgeFull: {
    fontSize: 12,
    color: "#a8825c",
    marginTop: IS_DESKTOP_WEB ? 0 : 1,
    fontWeight: "500",
  },
  memoryBadgeFullSpecial: { color: "rgba(255,255,255,0.9)" },

  addDateButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "#ddd",
    ...Platform.select({ web: { cursor: "pointer" } as any, default: {} }),
  },
  addDateButtonText: { fontSize: 12, color: "#999", fontWeight: "600" },

  // ── Memory date modal ─────────────────────────────────────
  dateModalHint: { fontSize: 13, color: "#888", marginBottom: 14 },
  dateModalRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  dateModalInput: {
    borderWidth: 1,
    borderColor: "#e0e0e0",
    borderRadius: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: "#111",
    backgroundColor: "#fafafa",
    textAlign: "center",
  },
  dateModalInputSmall: { width: 64 },
  dateModalInputLarge: { flex: 1 },
  primaryModalButton: {
    backgroundColor: "#111",
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
  },
  primaryModalButtonText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  clearDateButton: { alignItems: "center", paddingVertical: 12 },
  clearDateButtonText: {
    fontSize: 13,
    color: "rgba(220,40,40,0.8)",
    fontWeight: "600",
  },

  // ── Upload button ─────────────────────────────────────────
  uploadIconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#111",
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({ web: { cursor: "pointer" } as any, default: {} }),
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
  // Warm off-white background makes polaroids feel like they're
  // scattered on a table or pinned to a corkboard
  // No backgroundColor here — this content container used to paint a flat
  // color over the ENTIRE scroll area, which sat on top of AlbumBackground
  // and hid the texture completely across this whole screen. Transparent
  // now lets it show through.
  grid: {
    padding: 16,
    paddingTop: 24,
  },
  columns: { flexDirection: "row", gap: 0 },
  column: { flex: 1, alignItems: "center", gap: 20, paddingTop: 8 },

  // ── Polaroid wrapper — handles tilt transform ─────────────
  polaroidWrapper: {
    marginBottom: 4,
    // Extra margin to account for tilt overflow
    marginHorizontal: 4,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 2, height: 4 },
        shadowOpacity: 0.22,
        shadowRadius: 6,
      },
      android: { elevation: 6 },
      web: { filter: "drop-shadow(2px 4px 6px rgba(0,0,0,0.22))" } as any,
    }),
  },

  // ── Polaroid card — the white bordered photo card ─────────
  polaroidCard: {
    backgroundColor: "#fff",
    padding: 8,
    paddingBottom: 0,
    borderRadius: 2,
  },

  // ── Photo area inside the polaroid ────────────────────────
  polaroidPhotoArea: {
    overflow: "hidden",
    backgroundColor: "#e8e8e8",
  },

  // ── Caption strip — white space below photo ───────────────
  polaroidCaption: {
    height: 32,
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
  },
  // Subtle pencil-line effect in the caption area
  polaroidCaptionLine: {
    width: "60%",
    height: 1,
    backgroundColor: "#e8e8e8",
    borderRadius: 1,
  },

  // Legacy — kept for safety
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

  // ── Full screen viewer ────────────────────────────────────
  // Same warm background as the collection grid (was solid black) so
  // opening a photo feels continuous with the page it came from.
  fullScreenViewer: { flex: 1 },
  // Overlay rendered after FlatList — always sits on top
  viewerControls: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    pointerEvents: "box-none" as any,
  },
  // Was a translucent white circle on a black backdrop — flipped to dark
  // now that the backdrop is the light collection colour, so the icon
  // still has something to contrast against.
  fullScreenClose: {
    position: "absolute",
    top: Platform.OS === "web" ? 20 : 52,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  // Sits just to the left of fullScreenClose (44 width + 12 gap) in the
  // same top-right cluster, rather than competing with fullScreenDelete's
  // top-left spot (owner-only, and this button isn't).
  fullScreenFlip: {
    position: "absolute",
    top: Platform.OS === "web" ? 20 : 52,
    right: 76,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  fullScreenCounter: {
    position: "absolute",
    top: Platform.OS === "web" ? 26 : 58,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  fullScreenCounterText: {
    color: "rgba(0,0,0,0.55)",
    fontSize: 14,
    fontWeight: "600",
  },
  // paddingTop/paddingBottom carve out the safe zone described above the
  // VIEWER_TOP_CHROME/VIEWER_BOTTOM_CHROME constants — the card still
  // centers via justifyContent, just within that padded box instead of
  // the full page, so it can grow right up to the overlays on both sides
  // without the reserved space being wasted twice over.
  fullScreenPage: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: VIEWER_TOP_CHROME,
    paddingBottom: VIEWER_BOTTOM_CHROME,
  },
  webViewerWrapper: {
    flex: 1,
    width: "100%",
    height: SCREEN_HEIGHT,
    position: "relative",
    overflow: "hidden",
  },
  // The draggable layer sits under the floating arrows (rendered after it,
  // so on top by DOM/paint order) — panResponder only ever sees touches
  // that land on the image itself, never on the arrow buttons.
  webImageDragLayer: {
    justifyContent: "center",
    alignItems: "center",
    paddingTop: IS_DESKTOP_WEB ? 0 : VIEWER_TOP_CHROME,
    paddingBottom: IS_DESKTOP_WEB ? 0 : VIEWER_BOTTOM_CHROME,
    ...Platform.select({ web: { touchAction: "pan-y" } as any, default: {} }),
  },
  // ── Caption modal ─────────────────────────────────────────
  captionModalInput: {
    borderWidth: 1,
    borderColor: "#e0e0e0",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 14,
    color: "#111",
    backgroundColor: "#fafafa",
    minHeight: 84,
    textAlignVertical: "top",
    marginBottom: 6,
  },
  captionModalCounter: {
    fontSize: 12,
    color: "#999",
    textAlign: "right",
    marginBottom: 14,
  },
  // shareOverlayCard's own width: "100%" fills its padded backdrop —
  // fine for narrow phone/mobile-web viewports, but on a wide desktop
  // browser that stretched every one of these overlays (caption, share
  // photo, share collection) edge-to-edge almost the full window. A
  // percentage-of-screen width (the previous approach here) doesn't
  // really fix that on a large monitor — 65% of 1800px is still a huge
  // panel. A small popover, like the account/share menus elsewhere in
  // the app, reads as a proper desktop dialog instead: a fixed max width
  // that a phone-sized shareOverlayCard.width: "100%" never exceeds
  // anyway, so the same style is safe to apply unconditionally under
  // IS_DESKTOP_WEB across every overlay that reuses shareOverlayCard.
  desktopModalCard: {
    width: 420,
    maxWidth: 420,
    alignSelf: "center",
  },
  // Pagination dots — a fixed strip along the very bottom of the screen
  // (not attached to the polaroid card itself), so it never shifts with
  // each photo's own aspect ratio the way something anchored to the card
  // would. Dark, low-opacity dots read fine against the light album
  // texture background, mirroring fullScreenCounterText's same treatment.
  //
  // A single horizontally scrollable line rather than a wrapping row —
  // for a large collection, wrapping would grow the strip's height and
  // climb up over the photo; scrolling keeps it a constant, small height
  // regardless of how many photos there are.
  //
  // Fixed to DOTS_WINDOW_WIDTH (a handful of dots) and centered on screen
  // via `left`, rather than spanning the full width — a strip that only
  // ever shows ~5 dots reads as one small, centered indicator no matter
  // how many photos are in the collection, instead of thinning out across
  // the whole screen for a small collection or overflowing for a big one.
  pageDots: {
    position: "absolute",
    bottom: 10,
    left: (SCREEN_WIDTH - DOTS_WINDOW_WIDTH) / 2,
    width: DOTS_WINDOW_WIDTH,
    // Explicit height rather than relying on content to size an
    // absolutely-positioned box with only `bottom` set (no `top`) — some
    // react-native-web versions compute that as zero-height until content
    // has painted at least once, which reads as "invisible" rather than
    // "empty".
    height: 18,
    zIndex: 10,
  },
  pageDotsContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    // Half the WINDOW's width as padding on each side (not half the
    // screen) — without this, the ScrollView can't scroll far enough to
    // actually center the FIRST or LAST dot within the visible window
    // (there'd be nowhere further to scroll to once that dot reaches the
    // window's edge). See the auto-centering effect near
    // selectedPhotoIndex's declaration — its scroll-offset math assumes
    // this padding equals half of pageDots' own width.
    paddingHorizontal: DOTS_WINDOW_WIDTH / 2,
  },
  pageDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "rgba(0,0,0,0.28)",
  },
  pageDotActive: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  // Top-left twin of fullScreenClose (which sits top-right) — same fixed,
  // always-safe strip, so it never lands on top of the photo the way a
  // bottom-floating button could for some aspect ratios.
  fullScreenDelete: {
    position: "absolute",
    top: Platform.OS === "web" ? 20 : 52,
    left: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,60,60,0.75)",
    alignItems: "center",
    justifyContent: "center",
  },
  // Sits just to the right of fullScreenDelete (44 width + 12 gap), same
  // pairing pattern as fullScreenFlip/fullScreenClose on the other side.
  fullScreenSharePhoto: {
    position: "absolute",
    top: Platform.OS === "web" ? 20 : 52,
    left: 76,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },

  // Legacy viewer styles — kept for safety
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
  sharePhotoHint: {
    fontSize: 12,
    color: "#999",
    lineHeight: 17,
    marginBottom: 14,
  },
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
  toastButtonText: { fontSize: 12, fontWeight: "700", color: "#111" },
});
