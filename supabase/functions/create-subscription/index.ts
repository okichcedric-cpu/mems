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
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      consumer_key: Deno.env.get("PESAPAL_CONSUMER_KEY"),
      consumer_secret: Deno.env.get("PESAPAL_CONSUMER_SECRET"),
    }),
  });
  const text = await res.text();
  const data = JSON.parse(text);
  if (!data.token) throw new Error(`Failed to get Pesapal token: ${text}`);
  return data.token;
}

async function registerIPN(token: string, ipnUrl: string): Promise<string> {
  const res = await fetch(`${PESAPAL_BASE}/api/URLSetup/RegisterIPN`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      url: ipnUrl,
      ipn_notification_type: "POST",
    }),
  });
  const text = await res.text();
  const data = JSON.parse(text);
  if (!data.ipn_id) throw new Error(`Failed to register IPN: ${text}`);
  return data.ipn_id;
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

    const { plan, callbackUrl } = await req.json();
    console.log('Plan:', plan, 'Callback:', callbackUrl);

    const plans: Record<string, { amount: number; currency: string; label: string }> = {
      monthly: { amount: 130, currency: "KES", label: "Mems Monthly Subscription" },
      yearly: { amount: 1350, currency: "KES", label: "Mems Yearly Subscription" },
    };
    const selectedPlan = plans[plan] ?? plans.monthly;

    const token = await getPesapalToken();
    

    const ipnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/pesapal-webhook`;
    const notificationId = await registerIPN(token, ipnUrl);

    const merchantReference = `MEMS-${user.id.replace(/-/g, '').slice(0, 16)}-${Date.now().toString().slice(-10)}`;

    const orderRes = await fetch(
      `${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: merchantReference,
          currency: selectedPlan.currency,
          amount: selectedPlan.amount,
          description: selectedPlan.label,
          callback_url: callbackUrl,
          notification_id: notificationId,
          billing_address: {
            email_address: user.email,
          },
        }),
      }
    );

    const orderText = await orderRes.text();

    const orderData = JSON.parse(orderText);
    if (!orderData.redirect_url) {
      throw new Error(`Failed to create payment: ${orderText}`);
    }

    const { data: subData, error: subError } = await supabase
  .from("subscriptions")
  .upsert({
    user_id: user.id,
    status: "pending",
    plan,
    amount: selectedPlan.amount,
    currency: selectedPlan.currency,
    pesapal_merchant_reference: merchantReference,
    pesapal_tracking_id: orderData.order_tracking_id,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });

console.log('Subscription upsert result:', JSON.stringify(subData), subError?.message);

    

    return new Response(
      JSON.stringify({ redirect_url: orderData.redirect_url }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error('Stack:', error.stack);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});