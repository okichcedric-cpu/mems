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
        status: 401, headers: corsHeaders,
      });
    }

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );

    const { data: { user } } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );

    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: corsHeaders,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Get body — client sends merchantReference and tier
    let merchantReference: string | null = null;
    let tier: string | null = null;
    try {
      const body = await req.json();
      merchantReference = body.merchantReference ?? null;
      tier = body.tier ?? null;
    } catch {}

    // If not passed from client, look up from DB
    if (!merchantReference) {
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("pesapal_merchant_reference, tier")
        .eq("user_id", user.id)
        .maybeSingle();
      merchantReference = sub?.pesapal_merchant_reference ?? null;
      tier = tier ?? sub?.tier ?? null;
    }

    if (!merchantReference) {
      return new Response(
        JSON.stringify({ status: "no_reference" }),
        { status: 200, headers: corsHeaders },
      );
    }

    const token = await getPesapalToken();

    // Use merchant reference as the tracking ID for GetTransactionStatus
    // Pesapal accepts both orderTrackingId and merchantReference here
    const statusRes = await fetch(
      `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${merchantReference}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    const statusData = await statusRes.json();

    console.log("Pesapal status response:", JSON.stringify(statusData));

    // status_code 1 = COMPLETED
    if (statusData.status_code === 1) {
      await supabase.from("subscriptions").upsert({
        user_id: user.id,
        status: "active",
        tier,
        one_off: true,
        amount: statusData.amount,
        currency: "KES",
        pesapal_merchant_reference: merchantReference,
        pesapal_tracking_id: statusData.order_tracking_id ?? merchantReference,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

      return new Response(
        JSON.stringify({ status: "active", tier }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        status: statusData.payment_status_description ?? "pending",
      }),
      { status: 200, headers: corsHeaders },
    );
  } catch (error: any) {
    console.error("sync-subscription error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: corsHeaders,
    });
  }
});