import PushPin from "../../components/PushPin";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { useAuth } from "../../contexts/AuthContext";
import { marketplaceOrigin } from "../../utils/host";
import { startCheckout } from "../../utils/orders";
import ReportModal from "../../components/ReportModal";
import MarketplaceShell, { marketplaceText as t, polaroid } from "../../components/MarketplaceShell";
import { fetchListing, formatPrice, StoreListing } from "../../utils/listings";
import { buildCard, lastCardError, copyLink, facebookUrl, nativeShare, whatsappUrl } from "../../utils/share";

function ShareIcon({ icon, color, label, onPress }: { icon: any; color: string; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.shareItem} onPress={onPress}>
      <View style={styles.shareCircle}>
        <Ionicons name={icon} size={28} color={color} />
      </View>
      <Text style={styles.shareLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

// Public listing page: handwritten title, the seller's public previews as
// polaroids (watermarked), price, seller. Buying arrives with checkout.
export default function ListingPage() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width } = useWindowDimensions();
  const [listing, setListing] = useState<StoreListing | null | undefined>(undefined);
  const { session } = useAuth();
  const [buying, setBuying] = useState(false);
  // null = closed; otherwise the photo being reported (-1 = whole listing).
  const [reportTarget, setReportTarget] = useState<number | null>(null);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  async function share() {
    if (!listing) return;
    const blob = await buildCard(listing);
    const file = blob ? new File([blob], "mems-collection.jpg", { type: "image/jpeg" }) : null;
    const ok = await nativeShare(listing, file);
    if (ok) setShareOpen(false);
    else setShareNote("Sharing isn't supported here. Use an option above.");
  }

  async function downloadCard(forTikTok: boolean) {
    if (!listing) return;
    const blob = await buildCard(listing, { link: !forTikTok });
    if (!blob) {
      setShareNote(`Couldn't create the card (${lastCardError ?? "unknown error"}). Share the link instead.`);
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = forTikTok ? "mems-card-tiktok.jpg" : "mems-card.jpg";
    a.click();
    setShareNote(
      forTikTok
        ? "Card saved (no link, per TikTok rules). Upload it in TikTok and put the link in your profile."
        : "Card saved. Upload it to Instagram as a story or post and add the link in your bio or link sticker.",
    );
  }

  async function buy() {
    if (!listing || buying) return;
    // Buying is website-only: the Android app hands off to the browser.
    if (Platform.OS !== "web") {
      Linking.openURL(`${marketplaceOrigin()}/listing/${listing.id}`);
      return;
    }
    if (!session) {
      router.push(`/login?redirect=${encodeURIComponent(`listing/${listing.id}`)}` as any);
      return;
    }
    setBuying(true);
    setBuyError(null);
    try {
      const res = await startCheckout(listing.id);
      if (res.alreadyPurchased) {
        router.push(`/purchases/${res.orderId}` as any);
      } else {
        window.location.href = res.redirectUrl;
        return; // leaving the page; keep the spinner
      }
    } catch (e: any) {
      setBuyError(e?.message ?? "Could not start checkout.");
    }
    setBuying(false);
  }

  useEffect(() => {
    if (!id) return;
    fetchListing(String(id))
      .then(setListing)
      .catch(() => setListing(null));
  }, [id]);

  if (listing === undefined) {
    return (
      <MarketplaceShell title="Picture Board Marketplace">
        <ActivityIndicator color="#111" style={{ marginTop: 40 }} />
      </MarketplaceShell>
    );
  }
  if (listing === null) {
    return (
      <MarketplaceShell title="Not found">
        <Text style={t.heading}>This collection isn't available</Text>
        <TouchableOpacity onPress={() => router.replace("/marketplace" as any)}>
          <Text style={t.link}>Back to marketplace</Text>
        </TouchableOpacity>
      </MarketplaceShell>
    );
  }

  const cols = width >= 900 ? 3 : width >= 560 ? 2 : 1;
  const columns: { uri: string | null; idx: number }[][] = Array.from({ length: cols }, () => []);
  listing.previews.forEach((p, i) => columns[i % cols].push({ uri: p, idx: i }));
  const hidden = listing.photoCount - listing.previewCount;

  return (
    <MarketplaceShell title={`${listing.title} · Picture Board Marketplace`}>
      <Text style={t.heading}>{listing.title}</Text>
      <TouchableOpacity onPress={() => router.push(`/creator/${listing.seller.handle}` as any)}>
        <Text style={t.link}>by {listing.seller.displayName}</Text>
      </TouchableOpacity>
      {!!listing.description && <Text style={t.body}>{listing.description}</Text>}

      <View style={polaroid.wrapper}>
        <View style={[polaroid.card, styles.buyCard]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.price}>{formatPrice(listing.priceAmount, listing.currency)}</Text>
            <Text style={t.muted}>
              {listing.photoCount} {listing.photoCount === 1 ? "photo" : "photos"} · instant access
            </Text>
          </View>
          <TouchableOpacity style={styles.buy} onPress={buy} disabled={buying}>
            {buying ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buyText}>
                {session || Platform.OS !== "web" ? "Buy now" : "Sign in to buy"}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
      {!!buyError && <Text style={styles.buyError}>{buyError}</Text>}

      {Platform.OS === "web" && (
        <TouchableOpacity style={styles.shareOpen} onPress={() => { setShareNote(null); setShareOpen(true); }}>
          <Ionicons name="share-social-outline" size={18} color="#111" />
          <Text style={styles.shareBtnText}>Share</Text>
        </TouchableOpacity>
      )}
      <Modal visible={shareOpen} transparent animationType="fade" onRequestClose={() => setShareOpen(false)}>
        <Pressable style={styles.shareBackdrop} onPress={() => setShareOpen(false)}>
          <Pressable style={styles.shareSheet} onPress={() => {}}>
            <Text style={styles.shareTitle}>Share this collection</Text>
            <View style={styles.shareGrid}>
              {typeof navigator !== "undefined" && !!navigator.share && (
                <ShareIcon icon="share-outline" color="#111" label="More…" onPress={share} />
              )}
              <ShareIcon icon="logo-whatsapp" color="#25D366" label="WhatsApp" onPress={() => window.open(whatsappUrl(listing), "_blank")} />
              <ShareIcon icon="logo-facebook" color="#1877F2" label="Facebook" onPress={() => window.open(facebookUrl(listing), "_blank", "noopener,width=600,height=600")} />
              <ShareIcon icon="logo-instagram" color="#E1306C" label="Instagram" onPress={() => downloadCard(false)} />
              <ShareIcon icon="logo-tiktok" color="#111" label="TikTok" onPress={() => downloadCard(true)} />
              <ShareIcon
                icon="link-outline"
                color="#555"
                label="Copy link"
                onPress={async () => setShareNote((await copyLink(listing)) ? "Link copied." : "Couldn't copy the link.")}
              />
            </View>
            {!!shareNote && <Text style={[t.muted, { textAlign: "center" }]}>{shareNote}</Text>}
            <TouchableOpacity onPress={() => setShareOpen(false)} style={{ alignSelf: "center" }}>
              <Text style={styles.reportLink}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <Text style={t.subheading}>Preview</Text>
      <View style={{ flexDirection: "row", gap: 16 }}>
        {columns.map((col, ci) => (
          <View key={ci} style={{ flex: 1, gap: 16 }}>
            {col.map(({ uri, idx }) => (
              <View key={idx} style={polaroid.wrapper}>
        <PushPin />
                <View style={polaroid.card}>
                  <View style={styles.photoBox}>
                    {uri && <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" />}
                    {/* Watermark: tiled "Picture Board Marketplace" across the preview.
                        Pointer events off so it never blocks the page. */}
                    <View style={styles.watermark} pointerEvents="none">
                      <Text style={styles.watermarkText}>Picture Board Marketplace</Text>
                    </View>
                  </View>
                  <View style={styles.photoFooter}>
                    <TouchableOpacity
                      onPress={() => setReportTarget(idx)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.reportLink}>Report photo</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ))}
          </View>
        ))}
      </View>
      <TouchableOpacity onPress={() => setReportTarget(-1)} style={{ alignSelf: "center" }}>
        <Text style={styles.reportLink}>Report this collection</Text>
      </TouchableOpacity>
      <ReportModal
        visible={reportTarget !== null}
        onClose={() => setReportTarget(null)}
        listingId={listing.id}
        photoIndex={reportTarget !== null && reportTarget >= 0 ? reportTarget : null}
      />
      {hidden > 0 && (
        <Text style={[t.body, { textAlign: "center" }]}>
          + {hidden} more {hidden === 1 ? "photo" : "photos"} unlocked after purchase
        </Text>
      )}
    </MarketplaceShell>
  );
}

const styles = StyleSheet.create({
  shareOpen: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    borderWidth: 1,
    borderColor: "#111",
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  shareBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 16 },
  shareSheet: { backgroundColor: "#fff", borderRadius: 16, padding: 20, width: "100%", maxWidth: 420, gap: 16 },
  shareTitle: { fontFamily: "Caveat_700Bold", fontSize: 28, color: "#222", textAlign: "center" },
  shareGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 16 },
  shareItem: { width: 80, alignItems: "center", gap: 6 },
  shareCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: "#f3f3f3", alignItems: "center", justifyContent: "center" },
  shareLabel: { fontSize: 12, color: "#333" },
  shareBtnText: { fontSize: 14, fontWeight: "600", color: "#111" },
  photoFooter: { height: 28, justifyContent: "center", alignItems: "flex-end" },
  reportLink: { fontSize: 12, color: "#888", textDecorationLine: "underline" },
  buyCard: { padding: 16, flexDirection: "row", alignItems: "center", gap: 12 },
  price: { fontFamily: "Caveat_700Bold", fontSize: 32, color: "#222" },
  buy: {
    backgroundColor: "#111",
    borderRadius: 999,
    paddingHorizontal: 22,
    paddingVertical: 12,
    minWidth: 130,
    alignItems: "center",
  },
  buyText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  buyError: { color: "#c0392b", fontSize: 14 },
  photoBox: { width: "100%", aspectRatio: 1, backgroundColor: "#e8e8e8", overflow: "hidden" },
  watermark: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  watermarkText: {
    fontFamily: "Caveat_700Bold",
    fontSize: 34,
    color: "rgba(255,255,255,0.55)",
    transform: [{ rotate: "-24deg" }],
    textShadowColor: "rgba(0,0,0,0.35)",
    textShadowRadius: 3,
  },
});
