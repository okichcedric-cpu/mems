import { Platform } from "react-native";
import { marketplaceOrigin } from "./host";
import { formatPrice, invokeFn, StoreListing } from "./listings";

export function listingUrl(id: string): string {
  return `${marketplaceOrigin()}/listing/${id}`;
}

// Caption used for every share target: title, description, price, then the
// link on its own line so apps turn it into a tappable link.
export function shareText(l: StoreListing, withLink = true): string {
  const parts = [
    l.title,
    l.description?.trim(),
    `${l.photoCount} photos · ${formatPrice(l.priceAmount, l.currency)} · by ${l.seller.displayName}`,
  ].filter(Boolean) as string[];
  if (withLink) parts.push(listingUrl(l.id));
  return parts.join("\n\n");
}

export function whatsappUrl(l: StoreListing): string {
  return `https://wa.me/?text=${encodeURIComponent(shareText(l))}`;
}

// Facebook shows the page's Open Graph card (image/title/description) and the
// post links straight to the collection. `quote` pre-fills the description.
export function facebookUrl(l: StoreListing): string {
  return (
    `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(listingUrl(l.id))}` +
    `&quote=${encodeURIComponent(shareText(l, false).slice(0, 500))}`
  );
}

export async function copyLink(l: StoreListing): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(listingUrl(l.id));
    return true;
  } catch {
    return false;
  }
}

// Opens the device share sheet (Instagram, WhatsApp, Facebook, TikTok, ...).
// Returns false when unsupported so the caller can show the fallback buttons.
export async function nativeShare(l: StoreListing, card?: File | null): Promise<boolean> {
  if (Platform.OS !== "web" || typeof navigator === "undefined" || !navigator.share) return false;
  const data: ShareData = { title: l.title, text: shareText(l, false), url: listingUrl(l.id) };
  // Instagram/TikTok take the picture; WhatsApp/Facebook read text + link.
  if (card && navigator.canShare?.({ files: [card] })) {
    data.files = [card];
    // Many apps drop `url` when files are attached, so put it in the text.
    data.text = shareText(l);
    delete data.url;
  }
  try {
    await navigator.share(data);
  } catch (e: any) {
    if (e?.name !== "AbortError") return false;
  }
  return true;
}

// Draws a 1080x1920 story card (cover, title, price, link) on a canvas.
// Returns null if the image can't be read (cross-origin) so sharing still works.
function loadImage(src: string, cors: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const i = new window.Image();
    if (cors) i.crossOrigin = "anonymous";
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("image load failed"));
    i.src = src;
  });
}

// Tries our own-origin proxy first, then the CDN URL directly. If neither can
// be drawn on a canvas, the card is still made, just without the photo.
export let lastCardError: string | null = null;

export async function buildCard(
  l: StoreListing,
  opts: { link: boolean } = { link: true },
): Promise<Blob | null> {
  if (Platform.OS !== "web") return null;
  lastCardError = null;
  const direct = l.previews.find(Boolean);
  let img: HTMLImageElement | null = null;
  try {
    const res = await invokeFn<{ image: string | null }>("marketplace-listings", {
      action: "card-image",
      id: l.id,
    });
    if (res.image) img = await loadImage(res.image, false);
  } catch {}
  if (!img) img = await loadImage(`/api/listing-image?id=${encodeURIComponent(l.id)}&raw=1`, true).catch(() => null);
  if (!img && direct) img = await loadImage(direct, true).catch(() => null);
  try {
    const W = 1080, H = 1920;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d")!;
    g.fillStyle = "#f4efe6"; g.fillRect(0, 0, W, H);
    const pw = 900, px = (W - pw) / 2, py = 200, ph = 1060;
    g.shadowColor = "rgba(0,0,0,0.25)"; g.shadowBlur = 40; g.shadowOffsetY = 12;
    g.fillStyle = "#fff"; g.fillRect(px, py, pw, ph);
    g.shadowColor = "transparent";
    const ix = px + 40, iy = py + 40, iw = pw - 80, ih = 860;
    g.fillStyle = "#e8e8e8"; g.fillRect(ix, iy, iw, ih);
    if (img) {
      const s = Math.max(iw / img.width, ih / img.height);
      g.save(); g.beginPath(); g.rect(ix, iy, iw, ih); g.clip();
      g.drawImage(img, ix + (iw - img.width * s) / 2, iy + (ih - img.height * s) / 2, img.width * s, img.height * s);
      g.restore();
    } else {
      lastCardError = "photo unavailable";
    }
    g.fillStyle = "#222"; g.textAlign = "center";
    g.font = "700 64px Caveat, cursive";
    g.fillText(l.title.slice(0, 32), W / 2, py + ph - 70, pw - 80);
    g.font = "700 72px Caveat, cursive";
    g.fillText(formatPrice(l.priceAmount, l.currency), W / 2, 1400);
    g.font = "500 40px sans-serif"; g.fillStyle = "#555";
    g.fillText(`${l.photoCount} photos · by ${l.seller.displayName}`.slice(0, 50), W / 2, 1470);
    if (opts.link) {
      g.fillStyle = "#111"; g.font = "700 44px sans-serif";
      g.fillText(listingUrl(l.id).replace("https://", ""), W / 2, 1620, W - 120);
    }
    return await new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", 0.92));
  } catch (e: any) {
    lastCardError = e?.message ?? "canvas error";
    return null;
  }
}
