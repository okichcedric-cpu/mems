import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuth } from "../contexts/AuthContext";
import { getMyCreatorProfile } from "../utils/creator";
import {
  getMyListing,
  MyListing,
  PREVIEW_MAX,
  PRICE_MAX,
  PRICE_MIN,
  publishListing,
  unpublishListing,
} from "../utils/listings";
import { marketplaceOrigin } from "../utils/host";

// Owner-only dialog to sell a collection on the marketplace: set a title,
// price, and how many photos are publicly previewable. Everything else in
// the collection stays private until someone buys it.
export default function SellCollectionModal({
  visible,
  onClose,
  collectionName,
  photoCount,
}: {
  visible: boolean;
  onClose: () => void;
  collectionName: string;
  photoCount: number;
}) {
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user?.id;

  const [loading, setLoading] = useState(true);
  const [hasProfile, setHasProfile] = useState(true);
  const [listing, setListing] = useState<MyListing | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [previewCount, setPreviewCount] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxPreview = Math.max(1, Math.min(PREVIEW_MAX, photoCount));

  useEffect(() => {
    if (!visible || !userId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getMyCreatorProfile(userId), getMyListing(collectionName)])
      .then(([profile, existing]) => {
        if (cancelled) return;
        setHasProfile(!!profile && profile.status === "active");
        setListing(existing);
        setTitle(existing?.title ?? collectionName);
        setDescription(existing?.description ?? "");
        setPrice(existing ? String(existing.price_amount) : "");
        setPreviewCount(Math.min(existing?.preview_count ?? 3, maxPreview));
      })
      .catch(() => !cancelled && setError("Couldn't load. Please try again."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [visible, userId, collectionName, maxPreview]);

  async function publish() {
    const amount = parseInt(price.replace(/[^0-9]/g, ""), 10);
    if (!Number.isInteger(amount) || amount < PRICE_MIN || amount > PRICE_MAX) {
      setError(`Price must be between KES ${PRICE_MIN} and KES ${PRICE_MAX.toLocaleString("en-US")}.`);
      return;
    }
    if (title.trim().length < 3) {
      setError("Give your listing a title (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setListing(
        await publishListing({
          collectionName,
          title,
          description,
          priceAmount: amount,
          previewCount,
        }),
      );
      onClose();
    } catch (e: any) {
      setError(e?.message ?? "Could not publish.");
    } finally {
      setBusy(false);
    }
  }

  async function unpublish() {
    setBusy(true);
    setError(null);
    try {
      await unpublishListing(collectionName);
      setListing((l) => (l ? { ...l, status: "unpublished" } : l));
    } catch (e: any) {
      setError(e?.message ?? "Could not unpublish.");
    } finally {
      setBusy(false);
    }
  }

  const live = listing?.status === "published";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Sell this collection</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>

          {loading ? (
            <ActivityIndicator color="#111" style={{ margin: 32 }} />
          ) : !hasProfile ? (
            <View style={{ gap: 12 }}>
              <Text style={styles.body}>
                Set up your marketplace account first so buyers know who you are.
              </Text>
              <TouchableOpacity
                style={styles.primary}
                onPress={() => {
                  onClose();
                  router.push("/creator-setup" as any);
                }}
              >
                <Text style={styles.primaryText}>Set up marketplace account</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <ScrollView
                keyboardShouldPersistTaps="handled"
                style={styles.scroll}
                contentContainerStyle={{ paddingBottom: 8 }}
              >
                <View style={{ gap: 6 }}>
                  {live && (
                    <Text style={styles.live}>
                      Live on the marketplace · {marketplaceOrigin()}/listing/{listing!.id}
                    </Text>
                  )}

                  <Text style={styles.label}>Title</Text>
                  <TextInput
                    style={styles.input}
                    value={title}
                    onChangeText={setTitle}
                    maxLength={80}
                  />

                  <Text style={styles.label}>Description (optional)</Text>
                  <TextInput
                    style={[styles.input, { minHeight: 70, textAlignVertical: "top" }]}
                    value={description}
                    onChangeText={setDescription}
                    multiline
                    maxLength={600}
                  />

                  <Text style={styles.label}>Price (KES) for the whole collection</Text>
                  <TextInput
                    style={styles.input}
                    value={price}
                    onChangeText={(v) => setPrice(v.replace(/[^0-9]/g, ""))}
                    keyboardType="number-pad"
                    placeholder={`${PRICE_MIN} - ${PRICE_MAX.toLocaleString("en-US")}`}
                  />

                  <Text style={styles.label}>Photos visible to everyone</Text>
                  <View style={styles.stepper}>
                    <TouchableOpacity
                      style={styles.stepBtn}
                      onPress={() => setPreviewCount((n) => Math.max(1, n - 1))}
                    >
                      <Text style={styles.stepText}>−</Text>
                    </TouchableOpacity>
                    <Text style={styles.stepValue}>
                      {previewCount} of {photoCount}
                    </Text>
                    <TouchableOpacity
                      style={styles.stepBtn}
                      onPress={() => setPreviewCount((n) => Math.min(maxPreview, n + 1))}
                    >
                      <Text style={styles.stepText}>+</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.hint}>
                    The first {previewCount} {previewCount === 1 ? "photo is" : "photos are"} shown
                    publicly as small watermarked previews. Full-quality photos are
                    only available to people who buy. While listed, this collection
                    can't be renamed or deleted.
                  </Text>
                </View>
              </ScrollView>

              {/* Actions stay pinned below the scrolling form so they are
                  always visible, however long the form is. */}
              <View style={styles.footer}>
                {error && <Text style={styles.error}>{error}</Text>}
                <TouchableOpacity style={styles.primary} onPress={publish} disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.primaryText}>{live ? "Update listing" : "Publish to marketplace"}</Text>
                  )}
                </TouchableOpacity>
                {live && (
                  <TouchableOpacity style={styles.secondary} onPress={unpublish} disabled={busy}>
                    <Text style={styles.secondaryText}>Remove from marketplace</Text>
                  </TouchableOpacity>
                )}
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  card: { backgroundColor: "#fff", borderRadius: 2, padding: 20, width: "100%", maxWidth: 440, maxHeight: "92%" },
  scroll: { flexShrink: 1 },
  footer: { paddingTop: 4 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { fontFamily: "Caveat_700Bold", fontSize: 30, color: "#222" },
  close: { fontSize: 18, color: "#666" },
  body: { fontSize: 15, color: "#444", lineHeight: 22 },
  live: { fontSize: 12, color: "#1a7f4b", marginBottom: 6 },
  label: { fontSize: 13, fontWeight: "600", color: "#111", marginTop: 10 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: "#111",
  },
  stepper: { flexDirection: "row", alignItems: "center", gap: 14 },
  stepBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#111",
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: { color: "#fff", fontSize: 20, lineHeight: 22 },
  stepValue: { fontSize: 16, fontWeight: "600", color: "#111" },
  hint: { fontSize: 12, color: "#888", lineHeight: 17 },
  error: { color: "#c0392b", fontSize: 14, marginTop: 6 },
  primary: {
    backgroundColor: "#111",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 10,
  },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  secondary: { paddingVertical: 10, alignItems: "center" },
  secondaryText: { color: "#c0392b", fontSize: 14, fontWeight: "500" },
});
