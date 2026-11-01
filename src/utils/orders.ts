import { invokeFn } from "./listings";
import { supabase } from "./supabase";

export type Order = {
  id: string;
  collection_name: string;
  title: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded";
  created_at: string;
  paid_at: string | null;
};

export type PurchasedPhoto = { name: string; url: string | null; thumbUrl: string | null };

export type CheckoutResult =
  | { redirectUrl: string; orderId: string; alreadyPurchased?: undefined }
  | { alreadyPurchased: true; orderId: string; redirectUrl?: undefined };

// Starts a purchase. The price is read from the database on the server.
export async function startCheckout(listingId: string): Promise<CheckoutResult> {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://marketplace.mems-app.com";
  return invokeFn<CheckoutResult>("marketplace-checkout", {
    action: "create",
    listingId,
    origin,
  });
}

// Re-verifies a payment with the server (which asks Pesapal), so access
// doesn't depend on the payment notification arriving first.
export async function checkOrder(orderId: string): Promise<{ status: string }> {
  return invokeFn<{ status: string }>("marketplace-checkout", { action: "check", orderId });
}

const ORDER_COLUMNS =
  "id, collection_name, title, amount, currency, status, created_at, paid_at";

export async function fetchMyPurchases(): Promise<Order[]> {
  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("status", "paid")
    .order("paid_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Order[];
}

export async function fetchPurchasedCollection(orderId: string): Promise<{
  order: { id: string; title: string; paidAt: string | null };
  photos: PurchasedPhoto[];
}> {
  return invokeFn("get-purchased-collection", { orderId });
}

export type PurchaseSummary = {
  id: string;
  title: string;
  paidAt: string | null;
  coverUrl: string | null;
  // Up to three thumbnails, for the home-screen collage.
  coverUrls: string[];
};

// Paid purchases with a cover image, for the home screen (web and app).
export async function fetchPurchaseSummaries(): Promise<PurchaseSummary[]> {
  const res = await invokeFn<{ purchases: PurchaseSummary[] }>("get-purchased-collection", {
    action: "list",
  });
  return res.purchases ?? [];
}
