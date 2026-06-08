import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FREE_LIMITS = {
  maxCollections: 3,
  maxPhotosPerCollection: 10,
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ isSubscribed: false, limits: FREE_LIMITS }),
        { status: 200, headers: corsHeaders }
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
      authHeader.replace("Bearer ", "")
    );

    if (!user) {
      return new Response(
        JSON.stringify({ isSubscribed: false, limits: FREE_LIMITS }),
        { status: 200, headers: corsHeaders }
      );
    }

    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("status, current_period_end, plan")
      .eq("user_id", user.id)
      .maybeSingle();

    // Active and cancelled subscriptions both grant access until period ends
    const isSubscribed =
      (subscription?.status === "active" ||
        subscription?.status === "cancelled") &&
      subscription?.current_period_end !== null &&
      new Date(subscription.current_period_end) > new Date();

    const wasSubscribed =
      !!subscription && subscription.status !== "free";

    return new Response(
      JSON.stringify({
        isSubscribed: !!isSubscribed,
        plan: subscription?.plan ?? "free",
        expiresAt: subscription?.current_period_end ?? null,
        wasSubscribed,
        limits: isSubscribed ? null : FREE_LIMITS,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ isSubscribed: false, limits: FREE_LIMITS }),
      { status: 200, headers: corsHeaders }
    );
  }
});