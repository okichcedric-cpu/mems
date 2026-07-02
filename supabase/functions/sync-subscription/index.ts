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

function nextPeriod(): { start: string; end: string } {
  const start = new Date();
  const end = new Date(start);
  end.setDate(end.getDate() + 30);
  return { start: start.toISOString(), end: end.toISOString() };
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

    // Get merchantReference and tier from client request
    let merchantReference: string | null = null;
    let tier: string | null = null;
    try {
      const body = await req.json();
      merchantReference = body.merchantReference ?? null;
      tier = body.tier ?? null;
    } catch {}

    // Fall back to DB lookup if not passed
    if (!merchantReference) {
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("pesapal_merchant_reference, tier, status, current_period_end")
        .eq("user_id", user.id)
        .maybeSingle();

      merchantReference = sub?.pesapal_merchant_reference ?? null;
      tier = tier ?? sub?.tier ?? null;

      // If already active with valid period — no need to sync
      if (
        sub?.status === "active" &&
        sub?.current_period_end &&
        new Date(sub.current_period_end) > new Date()
      ) {
        return new Response(
          JSON.stringify({ status: "active", tier: sub.tier }),
          { status: 200, headers: corsHeaders },
        );
      }
    }

    if (!merchantReference) {
      return new Response(
        JSON.stringify({ status: "no_reference" }),
        { status: 200, headers: corsHeaders },
      );
    }

    const token = await getPesapalToken();

    // Poll Pesapal for this specific transaction
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

    console.log("Pesapal sync status:", JSON.stringify(statusData));

    // status_code 1 = COMPLETED
    if (statusData.status_code === 1) {
      const period = nextPeriod();

      await supabase.from("subscriptions").upsert({
        user_id: user.id,
        status: "active",
        tier,
        one_off: false,
        amount: statusData.amount,
        currency: "KES",
        pesapal_merchant_reference: merchantReference,
        pesapal_tracking_id: statusData.order_tracking_id ?? merchantReference,
        current_period_start: period.start,
        current_period_end: period.end,
        renewal_reminder_sent: false,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

      console.log(
        `Synced subscription for user ${user.id} — period ends ${period.end}`,
      );

      return new Response(
        JSON.stringify({ status: "active", tier }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
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
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
      status: 500, headers: corsHeaders,
    });
  }
});