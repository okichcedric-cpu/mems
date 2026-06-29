import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const PESAPAL_BASE =
  Deno.env.get("PESAPAL_ENV") === "sandbox"
    ? "https://cybqa.pesapal.com/pesapalv3"
    : "https://pay.pesapal.com/v3";

// Derive tier from merchant reference e.g. MEMS-MEDIUM-abc123-timestamp
function tierFromReference(reference: string): string | null {
  const match = reference.match(/^MEMS-([A-Z]+)-/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return ["small", "medium", "big"].includes(name) ? name : null;
}

// Derive tier from payment amount as fallback
function tierFromAmount(amount: number): string {
  if (amount >= 299) return "big";
  if (amount >= 179) return "medium";
  if (amount >= 99) return "small";
  return "free";
}

// Calculate the next billing period — 30 days from now
function nextPeriod(): { start: string; end: string } {
  const start = new Date();
  const end = new Date(start);
  end.setDate(end.getDate() + 30);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

async function getPesapalToken(): Promise<string> {
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const orderTrackingId = url.searchParams.get("OrderTrackingId");
    const merchantReference = url.searchParams.get("OrderMerchantReference");

    console.log(
      `Webhook received: orderTrackingId=${orderTrackingId} merchantReference=${merchantReference}`,
    );

    if (!orderTrackingId || !merchantReference) {
      console.error("Missing params in webhook");
      return new Response("Missing params", { status: 400 });
    }

    const token = await getPesapalToken();

    // Get transaction status from Pesapal
    const statusRes = await fetch(
      `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    const statusData = await statusRes.json();

    console.log(
      `Pesapal status for ${orderTrackingId}:`,
      JSON.stringify(statusData),
    );

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (statusData.status_code === 1) {
      // ── PAYMENT COMPLETED ──────────────────────────────
      const period = nextPeriod();

      // Look for existing row by merchant reference
      const { data: existing } = await supabase
        .from("subscriptions")
        .select("user_id, tier, status, current_period_end")
        .eq("pesapal_merchant_reference", merchantReference)
        .maybeSingle();

      if (existing) {
        // Row found — update to active with new billing period
        await supabase
          .from("subscriptions")
          .update({
            status: "active",
            one_off: false,
            pesapal_tracking_id: orderTrackingId,
            current_period_start: period.start,
            current_period_end: period.end,
            renewal_reminder_sent: false,
            updated_at: new Date().toISOString(),
          })
          .eq("pesapal_merchant_reference", merchantReference);

        console.log(
          `Activated subscription for user ${existing.user_id} — period ends ${period.end}`,
        );
      } else {
        // No row found — derive user from merchant reference
        const tier =
          tierFromReference(merchantReference) ||
          tierFromAmount(statusData.amount ?? 0);

        // Extract partial user ID from reference: MEMS-SMALL-{userId8chars}-{timestamp}
        const refParts = merchantReference.split("-");
        const userIdPrefix = refParts[2] ?? "";

        const { data: users } = await supabase.auth.admin.listUsers();
        const matchedUser = users?.users?.find((u: any) =>
          u.id.replace(/-/g, "").startsWith(userIdPrefix)
        );

        if (matchedUser) {
          await supabase.from("subscriptions").upsert({
            user_id: matchedUser.id,
            status: "active",
            tier,
            one_off: false,
            amount: statusData.amount ?? 0,
            currency: statusData.currency ?? "KES",
            pesapal_merchant_reference: merchantReference,
            pesapal_tracking_id: orderTrackingId,
            current_period_start: period.start,
            current_period_end: period.end,
            renewal_reminder_sent: false,
            updated_at: new Date().toISOString(),
          }, { onConflict: "user_id" });

          console.log(
            `Created subscription for user ${matchedUser.id} tier=${tier} period ends ${period.end}`,
          );
        } else {
          console.error(
            `Could not find user for merchant reference ${merchantReference}`,
          );
        }
      }
    } else if (statusData.status_code === 2) {
      // ── PAYMENT FAILED ─────────────────────────────────
      // Only update if a pending row exists — never touch an active subscription
      const { data: existing } = await supabase
        .from("subscriptions")
        .select("status")
        .eq("pesapal_merchant_reference", merchantReference)
        .maybeSingle();

      if (existing && existing.status === "pending") {
        await supabase
          .from("subscriptions")
          .update({
            status: "failed",
            pesapal_tracking_id: orderTrackingId,
            updated_at: new Date().toISOString(),
          })
          .eq("pesapal_merchant_reference", merchantReference);

        console.log(`Payment failed for ${merchantReference}`);
      }
    } else {
      console.log(
        `Payment status code ${statusData.status_code} — no action taken`,
      );
    }

    // Always return 200 to Pesapal — prevents endless retries
    return new Response("OK", { status: 200 });
  } catch (error: any) {
    console.error("pesapal-webhook error:", error.message);
    return new Response("OK", { status: 200 });
  }
});