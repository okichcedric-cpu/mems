import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TIERS = {
  small: { label: "Small Album", amount: 320, maxCollections: 15, maxPhotosPerCollection: 35 },
  medium: { label: "Medium Album", amount: 600, maxCollections: 30, maxPhotosPerCollection: 50 },
  big: { label: "Big Album", amount: 1150, maxCollections: 50, maxPhotosPerCollection: 75 },
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

    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser(authHeader.replace("Bearer ", ""));

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
    const merchantReference = `MEMS-${tier.toUpperCase()}-${user.id.slice(0, 8)}-${Date.now()}`;

    const token = await getPesapalToken();

    // Register IPN URL
    const ipnRes = await fetch(
      `${PESAPAL_BASE}/api/URLSetup/RegisterIPN`,
      {
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
      },
    );
    const ipnData = await ipnRes.json();
    const ipnId = ipnData.ipn_id;

    // Submit order
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

    if (!orderData.redirect_url) {
      throw new Error(orderData.message || "Failed to create Pesapal order");
    }

    // Save pending subscription
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    await supabase.from("subscriptions").upsert({
      user_id: user.id,
      status: "pending",
      tier,
      one_off: true,
      amount: tierConfig.amount,
      currency: "KES",
      pesapal_merchant_reference: merchantReference,
      pesapal_tracking_id: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

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