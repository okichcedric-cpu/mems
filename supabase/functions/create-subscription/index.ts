import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TIERS = {
  small: { label: "Small Album", amount: 320 },
  medium: { label: "Medium Album", amount: 600 },
  big: { label: "Big Album", amount: 1150 },
};

const PESAPAL_BASE =
  Deno.env.get("PESAPAL_ENV") === "sandbox"
    ? "https://cybqa.pesapal.com/pesapalv3"
    : "https://pay.pesapal.com/v3";

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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );

    const { data: { user }, error: authError } =
      await supabaseAuth.auth.getUser(authHeader.replace("Bearer ", ""));

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const { tier, callbackUrl } = await req.json();

    if (!TIERS[tier as keyof typeof TIERS]) {
      return new Response(JSON.stringify({ error: "Invalid tier" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const tierConfig = TIERS[tier as keyof typeof TIERS];

    // Merchant reference encodes tier and partial user ID so the
    // webhook can identify the user and tier even with no pending row
    const merchantReference =
      `MEMS-${tier.toUpperCase()}-${user.id.replace(/-/g, "").slice(0, 8)}-${Date.now()}`;

    const token = await getPesapalToken();

    // Register IPN URL
    const ipnRes = await fetch(`${PESAPAL_BASE}/api/URLSetup/RegisterIPN`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/pesapal-webhook`,
        ipn_notification_type: "GET",
      }),
    });
    const ipnData = await ipnRes.json();
    const ipnId = ipnData.ipn_id;

    console.log(`IPN registered: ${ipnId} for user ${user.id} tier ${tier}`);

    // Submit order to Pesapal
    const orderRes = await fetch(
      `${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: merchantReference,
          currency: "KES",
          amount: tierConfig.amount,
          description: `Mems ${tierConfig.label} — One-time payment`,
          callback_url: callbackUrl,
          notification_id: ipnId,
          billing_address: {
            email_address: user.email,
            first_name: "Mems",
            last_name: "User",
          },
        }),
      },
    );

    const orderData = await orderRes.json();

    console.log(`Pesapal order response:`, JSON.stringify(orderData));

    if (!orderData.redirect_url) {
      throw new Error(orderData.message || "Failed to create Pesapal order");
    }

    // ── Conditional DB write ──
    // Only store a pending record if the user has NO active subscription.
    // This protects existing subscribers from having their active status
    // overwritten if they try to buy another tier.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: existing } = await supabase
      .from("subscriptions")
      .select("status")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!existing) {
      // No record at all — safe to create a pending row
      // This helps sync-subscription find the merchant reference
      await supabase.from("subscriptions").insert({
        user_id: user.id,
        status: "pending",
        tier,
        one_off: true,
        amount: tierConfig.amount,
        currency: "KES",
        pesapal_merchant_reference: merchantReference,
        pesapal_tracking_id: null,
        updated_at: new Date().toISOString(),
      });
      console.log(`Created pending subscription for new user ${user.id}`);
    } else if (existing.status === "active") {
      // User already has an active subscription — do NOT touch it
      // The webhook will upsert on payment completion using the merchant reference
      console.log(
        `User ${user.id} has active subscription — skipping pending write to protect it`,
      );
    } else {
      // Has a non-active record (pending/failed) — update the reference
      // so sync-subscription can track this new payment attempt
      await supabase
        .from("subscriptions")
        .update({
          tier,
          amount: tierConfig.amount,
          pesapal_merchant_reference: merchantReference,
          pesapal_tracking_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id);
      console.log(
        `Updated pending/failed subscription reference for user ${user.id}`,
      );
    }

    return new Response(
      JSON.stringify({
        redirectUrl: orderData.redirect_url,
        merchantReference,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: any) {
    console.error("create-subscription error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});