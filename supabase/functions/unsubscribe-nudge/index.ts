import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";
import { verifyUnsubscribeToken } from "../_shared/unsubscribe.ts";

// ── Unsubscribe from the "create your first collection" reminder email ──
// Public by design (verify_jwt = false in config.toml): the link is clicked
// from an email, with no login. Safety comes from the signed `t` token.
//
//   POST ?u=<userId>&t=<token>   records the unsubscribe. Used both by the
//                                confirmation page's button and by email
//                                clients' one-click "Unsubscribe" button
//                                (List-Unsubscribe-Post).
//   GET  ?u=<userId>&t=<token>   changes NOTHING — just redirects to the
//                                confirmation page. Email security scanners
//                                often "click" every link in a message; if
//                                GET unsubscribed, they'd silently
//                                unsubscribe everyone.

const SITE_URL = "https://www.mems-app.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    let userId = url.searchParams.get("u") ?? "";
    let token = url.searchParams.get("t") ?? "";

    if (req.method === "GET") {
      const target = new URL(`${SITE_URL}/unsubscribe`);
      target.searchParams.set("u", userId);
      target.searchParams.set("t", token);
      return new Response(null, {
        status: 302,
        headers: { ...corsHeaders, Location: target.toString() },
      });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    // The confirmation page sends JSON; email clients' one-click POST sends
    // a form body but keeps u/t in the URL, handled above.
    if (!userId || !token) {
      try {
        const body = await req.json();
        userId = body?.u ?? "";
        token = body?.t ?? "";
      } catch {
        // no usable body
      }
    }

    if (!(await verifyUnsubscribeToken(userId, token))) {
      return json({ error: "Invalid or expired link" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    // Only touches unsubscribed_at; any existing nudge state on the row is
    // left alone.
    const { error } = await supabase.from("collection_nudges").upsert(
      { user_id: userId, unsubscribed_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) {
      console.error("unsubscribe-nudge upsert error:", error.message);
      return json({ error: "Could not update preference" }, 500);
    }

    return json({ success: true });
  } catch (error: any) {
    console.error("unsubscribe-nudge error:", error?.message);
    return json({ error: "Something went wrong" }, 500);
  }
});
