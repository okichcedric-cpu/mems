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
    const url = new URL(req.url);
    const orderTrackingId = url.searchParams.get("OrderTrackingId");
    const merchantReference = url.searchParams.get("OrderMerchantReference");

    if (!orderTrackingId || !merchantReference) {
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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // status_code 1 = COMPLETED
    if (statusData.status_code === 1) {
      await supabase
        .from("subscriptions")
        .update({
          status: "active",
          pesapal_tracking_id: orderTrackingId,
          updated_at: new Date().toISOString(),
        })
        .eq("pesapal_merchant_reference", merchantReference);

      console.log(`Payment completed for ${merchantReference}`);
    } else if (statusData.status_code === 2) {
      await supabase
        .from("subscriptions")
        .update({
          status: "failed",
          pesapal_tracking_id: orderTrackingId,
          updated_at: new Date().toISOString(),
        })
        .eq("pesapal_merchant_reference", merchantReference);
    }

    return new Response("OK", { status: 200 });
  } catch (error: any) {
    console.error("pesapal-webhook error:", error.message);
    return new Response("Error", { status: 500 });
  }
});