import { createClient } from "npm:@supabase/supabase-js";

// Shared by marketplace-checkout (buyer returns from payment) and
// marketplace-webhook (Pesapal IPN). Both end up in settleOrder(), which is
// idempotent: whichever arrives first settles the order, the other is a no-op.

export const PESAPAL_BASE =
  Deno.env.get("PESAPAL_ENV") === "sandbox"
    ? "https://cybqa.pesapal.com/pesapalv3"
    : "https://pay.pesapal.com/v3";

export function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

export async function getPesapalToken(): Promise<string> {
  const res = await fetch(`${PESAPAL_BASE}/api/Auth/RequestToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      consumer_key: Deno.env.get("PESAPAL_CONSUMER_KEY"),
      consumer_secret: Deno.env.get("PESAPAL_CONSUMER_SECRET"),
    }),
  });
  const data = await res.json();
  if (!data.token) throw new Error("Failed to get Pesapal token");
  return data.token;
}

export function marketplaceOrigin(): string {
  return (Deno.env.get("MARKETPLACE_ORIGIN") ?? "https://marketplace.mems-app.com")
    .replace(/\/+$/, "");
}

// Platform fee, as a percentage of the sale. Placeholder default — set
// MARKETPLACE_FEE_PERCENT to the real figure. Stored on each order when it
// is paid, so changing it later never rewrites past sales.
export function feePercent(): number {
  const n = parseFloat(Deno.env.get("MARKETPLACE_FEE_PERCENT") ?? "15");
  if (!Number.isFinite(n)) return 15;
  return Math.min(Math.max(n, 0), 100);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function sendEmail(to: string, subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return;
  const from = Deno.env.get("MARKETPLACE_EMAIL_FROM") ?? "Mems <hello@mems-app.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html, reply_to: "contact@mems-app.com" }),
  });
  if (!res.ok) console.error("marketplace email failed", res.status, await res.text());
}

async function sendOrderEmails(admin: ReturnType<typeof adminClient>, order: any) {
  try {
    const money = `${order.currency} ${Number(order.amount).toLocaleString("en-US")}`;
    const earn = `${order.currency} ${Number(order.seller_amount).toLocaleString("en-US")}`;
    const title = escapeHtml(order.title);

    const [{ data: buyer }, { data: seller }] = await Promise.all([
      admin.auth.admin.getUserById(order.buyer_id),
      admin.auth.admin.getUserById(order.seller_id),
    ]);

    if (buyer?.user?.email) {
      const link = `${marketplaceOrigin()}/purchases/${order.id}`;
      await sendEmail(
        buyer.user.email,
        `Your purchase: ${order.title}`,
        `<p>Thanks for your purchase.</p>
         <p><strong>${title}</strong><br>${escapeHtml(money)}</p>
         <p><a href="${link}">Open your collection</a> to view and download every photo.</p>
         <p style="color:#888;font-size:12px">Order ${order.id}</p>`,
      );
    }
    if (seller?.user?.email) {
      await sendEmail(
        seller.user.email,
        `You made a sale: ${order.title}`,
        `<p>Someone just bought <strong>${title}</strong>.</p>
         <p>Sale: ${escapeHtml(money)}<br>Your earnings after fees: ${escapeHtml(earn)}</p>
         <p style="color:#888;font-size:12px">Order ${order.id}</p>`,
      );
    }
    await admin.from("orders").update({ emails_sent_at: new Date().toISOString() })
      .eq("id", order.id);
  } catch (e) {
    console.error("sendOrderEmails error:", (e as Error).message);
  }
}

export type SettleResult = { status: string; orderId?: string };

// Looks the payment up with Pesapal (never trusts the caller's claim),
// verifies it against the order, and updates the order.
export async function settleOrder(
  orderTrackingId: string,
  fallbackReference?: string | null,
): Promise<SettleResult> {
  const admin = adminClient();
  const token = await getPesapalToken();

  const statusRes = await fetch(
    `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`,
    { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
  );
  const s = await statusRes.json();
  console.log(`Pesapal status for ${orderTrackingId}:`, JSON.stringify(s));

  const reference: string | null = s.merchant_reference ?? fallbackReference ?? null;
  if (!reference) return { status: "unknown" };

  const { data: order } = await admin
    .from("orders")
    .select("*")
    .eq("merchant_reference", reference)
    .maybeSingle();
  if (!order) return { status: "unknown" };

  // The tracking id must belong to this order.
  if (order.pesapal_tracking_id && order.pesapal_tracking_id !== orderTrackingId) {
    console.error(`Tracking id mismatch for order ${order.id}`);
    return { status: order.status, orderId: order.id };
  }

  if (s.status_code === 1) {
    if (order.status === "paid" || order.status === "refunded") {
      return { status: order.status, orderId: order.id };
    }
    // Pesapal is authoritative, but the amount and currency it reports must
    // match what we asked for — never grant access on a mismatch.
    if (Number(s.amount) !== Number(order.amount) || (s.currency && s.currency !== order.currency)) {
      console.error(
        `Amount mismatch for order ${order.id}: paid ${s.amount} ${s.currency}, expected ${order.amount} ${order.currency}`,
      );
      return { status: "needs_review", orderId: order.id };
    }

    const pct = feePercent();
    const fee = Math.round((order.amount * pct) / 100);
    const { data: updated, error } = await admin
      .from("orders")
      .update({
        status: "paid",
        pesapal_tracking_id: orderTrackingId,
        paid_at: new Date().toISOString(),
        fee_percent: pct,
        fee_amount: fee,
        seller_amount: order.amount - fee,
      })
      .eq("id", order.id)
      .in("status", ["pending", "failed"])
      .select("*")
      .maybeSingle();

    if (error) {
      // Most likely the buyer already holds a paid order for this
      // collection (paid twice). Flag for a manual refund.
      console.error(`NEEDS REFUND: could not mark order ${order.id} paid: ${error.message}`);
      return { status: "needs_review", orderId: order.id };
    }
    if (updated) {
      if (!updated.emails_sent_at) await sendOrderEmails(admin, updated);
      return { status: "paid", orderId: order.id };
    }
    const { data: now } = await admin.from("orders").select("status").eq("id", order.id).single();
    return { status: now?.status ?? order.status, orderId: order.id };
  }

  if (s.status_code === 2) {
    if (order.status === "pending") {
      await admin.from("orders").update({
        status: "failed",
        pesapal_tracking_id: orderTrackingId,
      }).eq("id", order.id).eq("status", "pending");
      return { status: "failed", orderId: order.id };
    }
    return { status: order.status, orderId: order.id };
  }

  if (s.status_code === 3 && order.status === "paid") {
    // Payment reversed by Pesapal: access is revoked.
    await admin.from("orders").update({
      status: "refunded",
      refunded_at: new Date().toISOString(),
    }).eq("id", order.id).eq("status", "paid");
    return { status: "refunded", orderId: order.id };
  }

  return { status: order.status, orderId: order.id };
}
