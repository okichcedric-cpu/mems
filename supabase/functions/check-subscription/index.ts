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
    label: "Small Album",
    maxCollections: 15,
    maxPhotosPerCollection: 35,
    price: 320,
  },
  medium: {
    label: "Medium Album",
    maxCollections: 30,
    maxPhotosPerCollection: 50,
    price: 600,
  },
  big: {
    label: "Big Album",
    maxCollections: 50,
    maxPhotosPerCollection: 75,
    price: 1150,
  },
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ tier: "free", limits: TIERS.free, isActive: false }),
        { status: 200, headers: corsHeaders },
      );
    }

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: { user } } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );

    if (!user) {
      return new Response(
        JSON.stringify({ tier: "free", limits: TIERS.free, isActive: false }),
        { status: 200, headers: corsHeaders },
      );
    }

    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("status, tier, one_off, amount, currency")
      .eq("user_id", user.id)
      .maybeSingle();

    const isActive =
      subscription?.status === "active" &&
      ["small", "medium", "big"].includes(subscription?.tier ?? "");

    const tier = isActive ? subscription!.tier : "free";
    const limits = TIERS[tier as keyof typeof TIERS] ?? TIERS.free;

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
  } catch (error) {
    return new Response(
      JSON.stringify({ tier: "free", limits: TIERS.free, isActive: false }),
      { status: 200, headers: corsHeaders },
    );
  }
});