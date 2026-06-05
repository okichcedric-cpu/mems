import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PESAPAL_BASE = Deno.env.get("PESAPAL_ENV") === "sandbox"
  ? "https://cybqa.pesapal.com/pesapalv3"
  : "https://pay.pesapal.com/v3";

async function getPesapalToken(): Promise<string> {
  const res = await fetch(`${PESAPAL_BASE}/api/Auth/RequestToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      consumer_key: Deno.env.get("PESAPAL_CONSUMER_KEY"),
      consumer_secret: Deno.env.get("PESAPAL_CONSUMER_SECRET"),
    }),
  });
  const data = await res.json();
  if (!data.token) throw new Error("Failed to get token");
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
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: corsHeaders,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Get the latest pending subscription for this user
    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .maybeSingle();

    if (!subscription?.pesapal_tracking_id) {
      return new Response(
        JSON.stringify({ message: "No pending subscription found" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check transaction status with Pesapal
    const token = await getPesapalToken();
    const statusRes = await fetch(
      `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${subscription.pesapal_tracking_id}`,
      {
        headers: {
          "Accept": "application/json",
          "Authorization": `Bearer ${token}`,
        },
      }
    );
    const statusData = await statusRes.json();
console.log('Transaction status_code:', statusData.status_code);
console.log('Transaction description:', statusData.payment_status_description);

// Use status_code: 1 = COMPLETED, 2 = FAILED, 0 = INVALID, 3 = REVERSED
const isPaid = statusData.status_code === 1;
const isFailed = statusData.status_code === 2 ||
                 statusData.status_code === 0 ||
                 statusData.status_code === 3;

if (isPaid) {
  const now = new Date();
  const periodEnd = new Date(now);

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("plan")
    .eq("pesapal_merchant_reference", merchantReference)
    .maybeSingle();

  if (sub?.plan === "yearly") {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  await supabase
    .from("subscriptions")
    .update({
      status: "active",
      pesapal_tracking_id: trackingId,
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("pesapal_merchant_reference", merchantReference);

} else if (isFailed) {
  // Delete the failed subscription record entirely
  await supabase
    .from("subscriptions")
    .delete()
    .eq("pesapal_merchant_reference", merchantReference);
}

    return new Response(
      JSON.stringify({ activated: false, status: statusData.payment_status_description }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("sync-subscription error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: corsHeaders,
    });
  }
});