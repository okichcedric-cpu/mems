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
  amount: 0,
  currency: "KES",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");

    // No auth header — return free tier immediately
    if (!authHeader) {
      return new Response(
        JSON.stringify(FREE_RESPONSE),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Verify the user JWT
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

    // Look up subscription with service role to bypass RLS
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: subscription, error: dbError } = await supabase
      .from("subscriptions")
      .select("status, tier, one_off, amount, currency, pesapal_merchant_reference")
      .eq("user_id", user.id)
      .maybeSingle();

    if (dbError) {
      console.error("DB error in check-subscription:", dbError.message);
    }

    // A subscription is active only when:
    // 1. status is explicitly "active"
    // 2. tier is one of the paid tiers
    const isActive =
      subscription?.status === "active" &&
      ["small", "medium", "big"].includes(subscription?.tier ?? "");

    const tier = isActive
      ? (subscription!.tier as keyof typeof TIERS)
      : "free";

    const limits = TIERS[tier] ?? TIERS.free;

    console.log(
      `check-subscription: user=${user.id} tier=${tier} isActive=${isActive} status=${subscription?.status ?? "none"}`,
    );

    return new Response(
      JSON.stringify({
        tier,
        limits,
        isActive,
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
    // Always return a valid response — never let this crash the app
    return new Response(
      JSON.stringify(FREE_RESPONSE),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});