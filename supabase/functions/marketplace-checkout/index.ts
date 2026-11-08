import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";
import {
  adminClient,
  getPesapalToken,
  PESAPAL_BASE,
  settleOrder,
} from "../_shared/marketplaceOrders.ts";

// Buyer-side checkout. Actions (all require a signed-in buyer):
//   create { listingId, origin? }  -> { redirectUrl, orderId } or
//                                     { alreadyPurchased: true, orderId }
//   check  { orderId }             -> { status, orderId }  (re-verifies with
//                                     Pesapal so access never depends on the
//                                     IPN arriving first)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Where Pesapal may send the buyer back to. Only our own sites.
const ALLOWED_ORIGINS = new Set([
  "https://marketplace.mems-app.com",
  "https://www.mems-app.com",
  ...(Deno.env.get("MARKETPLACE_EXTRA_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Please sign in to continue." }, 401);

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) return json({ error: "Please sign in to continue." }, 401);

    const body = await req.json().catch(() => ({}));
    const admin = adminClient();

    // ── check ──────────────────────────────────────────────────────────
    if (body.action === "check") {
      const orderId = String(body.orderId ?? "");
      if (!UUID.test(orderId)) return json({ error: "Invalid order." }, 400);
      const { data: order } = await admin
        .from("orders")
        .select("id, status, pesapal_tracking_id, buyer_id")
        .eq("id", orderId)
        .maybeSingle();
      if (!order || order.buyer_id !== user.id) return json({ error: "Order not found." }, 404);

      if (order.status === "pending" && order.pesapal_tracking_id) {
        const result = await settleOrder(order.pesapal_tracking_id);
        return json({ status: result.status, orderId });
      }
      return json({ status: order.status, orderId });
    }

    if (body.action !== "create") return json({ error: "Invalid request." }, 400);

    // ── create ─────────────────────────────────────────────────────────
    const listingId = String(body.listingId ?? "");
    if (!UUID.test(listingId)) return json({ error: "Invalid listing." }, 400);

    // Price and ownership always come from the database, never the client.
    const { data: listing } = await admin
      .from("listings")
      .select("id, seller_id, collection_name, title, price_amount, currency, status")
      .eq("id", listingId)
      .maybeSingle();
    if (!listing || listing.status !== "published") {
      return json({ error: "This collection is no longer available." }, 404);
    }
    const { data: seller } = await admin
      .from("creator_profiles")
      .select("status")
      .eq("user_id", listing.seller_id)
      .maybeSingle();
    if (!seller || seller.status !== "active") {
      return json({ error: "This collection is no longer available." }, 404);
    }
    if (listing.seller_id === user.id) {
      return json({ error: "You can't buy your own collection." }, 400);
    }

    const { data: already } = await admin
      .from("orders")
      .select("id")
      .eq("buyer_id", user.id)
      .eq("seller_id", listing.seller_id)
      .eq("collection_name", listing.collection_name)
      .eq("status", "paid")
      .maybeSingle();
    if (already) return json({ alreadyPurchased: true, orderId: already.id });

    const origin = ALLOWED_ORIGINS.has(String(body.origin ?? ""))
      ? String(body.origin)
      : "https://marketplace.mems-app.com";

    const orderId = crypto.randomUUID();
    const merchantReference = `MKT-${orderId.replace(/-/g, "")}`;

    const { error: insertError } = await admin.from("orders").insert({
      id: orderId,
      listing_id: listing.id,
      buyer_id: user.id,
      seller_id: listing.seller_id,
      collection_name: listing.collection_name,
      title: listing.title,
      amount: listing.price_amount,
      currency: listing.currency,
      status: "pending",
      merchant_reference: merchantReference,
    });
    if (insertError) return json({ error: "Could not start checkout." }, 500);

    try {
      const token = await getPesapalToken();
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      };

      const ipnRes = await fetch(`${PESAPAL_BASE}/api/URLSetup/RegisterIPN`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/marketplace-webhook`,
          ipn_notification_type: "GET",
        }),
      });
      const ipn = await ipnRes.json();

      const orderRes = await fetch(`${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: merchantReference,
          currency: listing.currency,
          amount: listing.price_amount,
          description: `Picture Board Marketplace: ${listing.title}`.slice(0, 100),
          callback_url: `${origin}/purchase-callback?order=${orderId}`,
          notification_id: ipn.ipn_id,
          billing_address: {
            email_address: user.email,
            first_name: user.email ?? "Picture Board Buyer",
            last_name: "",
          },
        }),
      });
      const data = await orderRes.json();
      if (!data.redirect_url) throw new Error(data.message || "Pesapal did not return a payment link");

      if (data.order_tracking_id) {
        await admin.from("orders")
          .update({ pesapal_tracking_id: data.order_tracking_id })
          .eq("id", orderId);
      }
      return json({ redirectUrl: data.redirect_url, orderId });
    } catch (e) {
      console.error("marketplace-checkout create error:", (e as Error).message);
      await admin.from("orders").update({ status: "failed" }).eq("id", orderId).eq("status", "pending");
      return json({ error: "Could not start payment. Please try again." }, 502);
    }
  } catch (e) {
    console.error("marketplace-checkout error:", (e as Error).message);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
