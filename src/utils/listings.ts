import { supabase } from "./supabase";

export type ListingSeller = { handle: string; displayName: string };

// Public storefront shape (from the marketplace-listings edge function).
export type StoreListing = {
  id: string;
  title: string;
  description: string;
  priceAmount: number;
  currency: string;
  previewCount: number;
  photoCount: number;
  createdAt: string;
  seller: ListingSeller;
  // Signed thumbnail URLs of the seller's public preview photos only.
  previews: (string | null)[];
};

// The seller's own view of their listing for one collection.
export type MyListing = {
  id: string;
  collection_name: string;
  title: string;
  description: string;
  price_amount: number;
  currency: string;
  preview_count: number;
  photo_count: number;
  status: "published" | "unpublished";
};

export const PRICE_MIN = 100;
export const PRICE_MAX = 500000;
export const PREVIEW_MAX = 20;

export function formatPrice(amount: number, currency = "KES"): string {
  return `${currency} ${amount.toLocaleString("en-US")}`;
}

export async function invokeFn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    // Surface the function's own message when it sent one.
    let message = "Something went wrong. Please try again.";
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === "function") {
        const parsed = await ctx.json();
        if (parsed?.error) message = parsed.error;
      }
    } catch {}
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data as T;
}

// ── Public reads ─────────────────────────────────────────────────────────
export async function fetchListings(sellerHandle?: string): Promise<StoreListing[]> {
  const res = await invokeFn<{ listings: StoreListing[] }>("marketplace-listings", {
    action: "list",
    sellerHandle,
  });
  return res.listings ?? [];
}

export async function fetchListing(id: string): Promise<StoreListing | null> {
  const res = await invokeFn<{ listing: StoreListing | null }>("marketplace-listings", {
    action: "get",
    id,
  });
  return res.listing ?? null;
}

// ── Seller actions ───────────────────────────────────────────────────────
export async function getMyListing(collectionName: string): Promise<MyListing | null> {
  const res = await invokeFn<{ listing: MyListing | null }>("manage-listing", {
    action: "get",
    collectionName,
  });
  return res.listing ?? null;
}

export async function publishListing(input: {
  collectionName: string;
  title: string;
  description: string;
  priceAmount: number;
  previewCount: number;
}): Promise<MyListing> {
  const res = await invokeFn<{ listing: MyListing }>("manage-listing", {
    action: "publish",
    ...input,
  });
  return res.listing;
}

export async function unpublishListing(collectionName: string): Promise<void> {
  await invokeFn("manage-listing", { action: "unpublish", collectionName });
}

// ── Reporting ────────────────────────────────────────────────────────────
export const REPORT_REASONS: { value: string; label: string }[] = [
  { value: "child_safety", label: "Child safety concern" },
  { value: "sexual_content", label: "Sexual or explicit content" },
  { value: "violence_hate", label: "Violence, hate or harassment" },
  { value: "copyright", label: "Copyright / not the seller's work" },
  { value: "privacy", label: "People shown without consent" },
  { value: "scam_misleading", label: "Scam or misleading" },
  { value: "other", label: "Something else" },
];

// Reports a listing, or one of its public preview photos (0-based index).
// Works signed out; `email` is optional for follow-up.
export async function reportListing(input: {
  listingId: string;
  reason: string;
  details?: string;
  photoIndex?: number | null;
  email?: string;
}): Promise<void> {
  await invokeFn("report-content", input);
}
