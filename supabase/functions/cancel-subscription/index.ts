import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Must match src/android/package in app.json — see verify-google-purchase's
// PACKAGE_NAME comment for why this is duplicated rather than shared.
const PACKAGE_NAME = "com.cedricodera.Mems";

function base64url(input: ArrayBuffer | string): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importGoogleServiceAccountKey(pem: string): Promise<CryptoKey> {
  const pemContents = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// Same JWT-Bearer service-account flow as verify-google-purchase/
// google-rtdn-webhook — duplicated rather than shared (see those files'
// comments on why this codebase doesn't use a _shared/ import convention).
async function getGoogleAccessToken(): Promise<string> {
  const clientEmail = Deno.env.get("GOOGLE_PLAY_CLIENT_EMAIL");
  const rawPrivateKey = Deno.env.get("GOOGLE_PLAY_PRIVATE_KEY");
  if (!clientEmail || !rawPrivateKey) {
    throw new Error(
      "GOOGLE_PLAY_CLIENT_EMAIL / GOOGLE_PLAY_PRIVATE_KEY not configured",
    );
  }
  const privateKeyPem = rawPrivateKey.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claimSet),
  )}`;

  const key = await importGoogleServiceAccountKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    console.error("Google token exchange failed:", JSON.stringify(data));
    throw new Error("Could not authenticate with Google Play");
  }
  return data.access_token;
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

    const { data: { user }, error: authError } =
      await supabaseAuth.auth.getUser(authHeader.replace("Bearer ", ""));

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: corsHeaders,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Check they have an active subscription to cancel
    const { data: existing } = await supabase
      .from("subscriptions")
      .select(
        "status, tier, current_period_end, payment_provider, google_play_purchase_token",
      )
      .eq("user_id", user.id)
      .maybeSingle();

    if (!existing || existing.status !== "active") {
      return new Response(
        JSON.stringify({ error: "No active subscription to cancel" }),
        { status: 400, headers: corsHeaders },
      );
    }

    // ── Google Play: actually stop the real auto-renewal ──
    // Setting our own DB row to "cancelled" (below) isn't enough on its
    // own for a Google Play subscriber — Google auto-renews and
    // auto-charges independently of what our database says, and the RTDN
    // webhook would just flip the row back to active on the next renewal
    // if we didn't also tell Google to stop it here. This mirrors
    // USER_REQUESTED_STOP_RENEWALS semantics: the subscription stays valid
    // until current_period_end (matching the Pesapal path below) and can
    // still be restored by the user from Google Play before then.
    if (existing.payment_provider === "google_play") {
      if (!existing.google_play_purchase_token) {
        console.error(
          `cancel-subscription: user ${user.id} has payment_provider=google_play but no purchase token on file`,
        );
        return new Response(
          JSON.stringify({
            error:
              "Could not cancel automatically. Please cancel from the Play Store instead.",
          }),
          { status: 500, headers: corsHeaders },
        );
      }

      const accessToken = await getGoogleAccessToken();
      const cancelRes = await fetch(
        `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptionsv2/tokens/${existing.google_play_purchase_token}:cancel`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            cancellationContext: {
              cancellationType: "USER_REQUESTED_STOP_RENEWALS",
            },
          }),
        },
      );

      if (!cancelRes.ok) {
        const errBody = await cancelRes.text();
        console.error(
          `Google Play cancel API error (${cancelRes.status}):`,
          errBody,
        );
        // Don't touch our DB if Google's own cancellation failed — leaving
        // status "active" is honest; telling the user it's cancelled here
        // when Google will still bill them would be worse than showing
        // this error and asking them to retry or use the Play Store.
        return new Response(
          JSON.stringify({
            error:
              "Could not cancel through Google Play. Please try again, or cancel directly from the Play Store.",
          }),
          { status: 502, headers: corsHeaders },
        );
      }

      console.log(
        `Google Play subscription cancelled via API for user ${user.id} (purchaseToken=${existing.google_play_purchase_token})`,
      );
    }

    // Set status to 'cancelled' — access continues until current_period_end
    // The period end is NOT changed — they keep what they paid for
    await supabase
      .from("subscriptions")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id);

    console.log(
      `Subscription cancelled for user ${user.id} — access until ${existing.current_period_end}`,
    );

    return new Response(
      JSON.stringify({
        success: true,
        message: "Subscription cancelled",
        accessUntil: existing.current_period_end,
        tier: existing.tier,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: any) {
    console.error("cancel-subscription error:", error.message);
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
      status: 500, headers: corsHeaders,
    });
  }
});