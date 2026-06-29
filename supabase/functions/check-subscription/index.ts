import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TIERS = {
  free: {
    label: "Free",
    maxCollections: 3,
    maxPhotosPerCollection: 10,
    price: 0,
  },
  small: {
    label: "Small",
    maxCollections: 15,
    maxPhotosPerCollection: 35,
    price: 320,
  },
  medium: {
    label: "Medium",
    maxCollections: 30,
    maxPhotosPerCollection: 50,
    price: 600,
  },
  big: {
    label: "Big",
    maxCollections: 50,
    maxPhotosPerCollection: 75,
    price: 1150,
  },
};

const FREE_RESPONSE = {
  tier: "free",
  limits: TIERS.free,
  isActive: false,
  isLapsed: false,
  periodEnd: null,
  amount: 0,
  currency: "KES",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return new Response(
        JSON.stringify(FREE_RESPONSE),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );

    if (authError || !user) {
      return new Response(
        JSON.stringify(FREE_RESPONSE),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: subscription, error: dbError } = await supabase
      .from("subscriptions")
      .select("status, tier, amount, currency, current_period_start, current_period_end, renewal_reminder_sent")
      .eq("user_id", user.id)
      .maybeSingle();

    if (dbError) {
      console.error("DB error in check-subscription:", dbError.message);
    }

    const now = new Date();
    const periodEnd = subscription?.current_period_end
      ? new Date(subscription.current_period_end)
      : null;

    const hasValidTier = ["small", "medium", "big"].includes(
      subscription?.tier ?? "",
    );

    // Active = status is active or cancelled AND period has not expired
    // (cancelled means they cancelled but still have time left)
    const isActive =
      (subscription?.status === "active" || subscription?.status === "cancelled") &&
      hasValidTier &&
      periodEnd !== null &&
      periodEnd > now;

    // Lapsed = had a paid tier but period has expired
    // Show them a renew prompt rather than treating as a new user
    const isLapsed =
      hasValidTier &&
      periodEnd !== null &&
      periodEnd <= now &&
      (subscription?.status === "active" ||
        subscription?.status === "cancelled" ||
        subscription?.status === "lapsed");

    const tier = isActive
      ? (subscription!.tier as keyof typeof TIERS)
      : "free";

    const limits = TIERS[tier] ?? TIERS.free;

    console.log(
      `check-subscription: user=${user.id} tier=${tier} isActive=${isActive} isLapsed=${isLapsed} periodEnd=${periodEnd?.toISOString() ?? "none"}`,
    );

    // If subscription has lapsed, update status in DB
    if (isLapsed && subscription?.status === "active") {
      await supabase
        .from("subscriptions")
        .update({ status: "lapsed", updated_at: now.toISOString() })
        .eq("user_id", user.id);
    }

    return new Response(
      JSON.stringify({
        tier,
        limits,
        isActive,
        isLapsed,
        periodEnd: subscription?.current_period_end ?? null,
        amount: subscription?.amount ?? 0,
        currency: subscription?.currency ?? "KES",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: any) {
    console.error("check-subscription error:", error.message);
    return new Response(
      JSON.stringify(FREE_RESPONSE),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});