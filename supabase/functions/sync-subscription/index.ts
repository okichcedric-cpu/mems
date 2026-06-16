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
    } = await supabaseAuth.auth.getUser(authHeader.replace("Bearer ", ""));

    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Get the pending subscription for this user
    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("pesapal_merchant_reference, pesapal_tracking_id, status, tier")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!subscription || subscription.status === "active") {
      return new Response(
        JSON.stringify({ status: subscription?.status ?? "none", tier: subscription?.tier ?? "free" }),
        { status: 200, headers: corsHeaders },
      );
    }

    if (!subscription.pesapal_merchant_reference) {
      return new Response(
        JSON.stringify({ status: "pending", tier: "free" }),
        { status: 200, headers: corsHeaders },
      );
    }

    // Poll Pesapal for latest status
    const token = await getPesapalToken();
    const trackingId = subscription.pesapal_tracking_id ?? subscription.pesapal_merchant_reference;

    const statusRes = await fetch(
      `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${trackingId}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    const statusData = await statusRes.json();

    let newStatus = subscription.status;

    if (statusData.status_code === 1) {
      newStatus = "active";
      await supabase
        .from("subscriptions")
        .update({
          status: "active",
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id);
    } else if (statusData.status_code === 2) {
      newStatus = "failed";
      await supabase
        .from("subscriptions")
        .update({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id);
    }

    return new Response(
      JSON.stringify({ status: newStatus, tier: subscription.tier }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: any) {
    console.error("sync-subscription error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});