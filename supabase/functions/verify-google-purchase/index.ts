import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Must match src/android/package in app.json — this is the Android
// package name the Play Developer API needs to look up purchases against.
const PACKAGE_NAME = "com.cedricodera.Mems";

// Mirrors src/utils/googlePlayBilling.ts's ANDROID_SUBSCRIPTION_SKUS.
// Kept as a separate copy (edge functions can't import from src/) — if you
// change one, change the other.
const ANDROID_SUBSCRIPTION_SKUS: Record<string, string> = {
  small: "mems_small_monthly",
  medium: "mems_medium_monthly",
  big: "mems_big_monthly",
};

// Mirrors the pricing in check-subscription/create-subscription. Google
// Play bills the user directly in their local currency (which may differ
// from this), so this is what we *display* as the plan's cost, not a
// record of what was actually charged.
const TIER_AMOUNTS: Record<string, number> = {
  small: 99,
  medium: 179,
  big: 299,
};

// Subscription states that mean the user currently has access. Anything
// else (PAUSED, ON_HOLD, EXPIRED, PENDING, PENDING_PURCHASE_CANCELED,
// UNSPECIFIED) is deliberately NOT included here — check-subscription's
// isActive check requires status to be exactly "active" or "cancelled",
// so leaving those out is what keeps a suspended/expired Google
// subscription from being treated as active regardless of dates.
// https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2#SubscriptionState
function mapSubscriptionState(
  state: string,
): "active" | "cancelled" | "lapsed" {
  if (state === "SUBSCRIPTION_STATE_ACTIVE") return "active";
  if (state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD") return "active";
  if (state === "SUBSCRIPTION_STATE_CANCELED") return "cancelled";
  return "lapsed";
}

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

// Server-to-server OAuth2 (RFC 7523 JWT Bearer flow) against the Play
// Console service account — see Phase 1's setup guide for how that
// account and its key were created. Hand-rolled with Web Crypto rather
// than pulling in the (large, Node-oriented) `googleapis` package, to
// stay consistent with the rest of this codebase's plain-fetch style
// (see getPesapalToken in create-subscription/sync-subscription).
async function getGoogleAccessToken(): Promise<string> {
  const clientEmail = Deno.env.get("GOOGLE_PLAY_CLIENT_EMAIL");
  const rawPrivateKey = Deno.env.get("GOOGLE_PLAY_PRIVATE_KEY");
  if (!clientEmail || !rawPrivateKey) {
    throw new Error(
      "GOOGLE_PLAY_CLIENT_EMAIL / GOOGLE_PLAY_PRIVATE_KEY not configured",
    );
  }
  // Secrets are commonly stored with literal "\n" sequences rather than
  // real newlines (safer to paste as a single-line CLI arg) — normalize
  // either way.
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
      error: authError,
    } = await supabaseAuth.auth.getUser(authHeader.replace("Bearer ", ""));

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const { tier, productId, purchaseToken } = await req.json();

    if (
      !tier ||
      !productId ||
      !purchaseToken ||
      typeof purchaseToken !== "string"
    ) {
      return new Response(JSON.stringify({ error: "Invalid request" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Reject up front if the claimed tier and product ID don't even match
    // our own known mapping — cheaper than calling out to Google for an
    // obviously malformed request.
    if (ANDROID_SUBSCRIPTION_SKUS[tier] !== productId) {
      return new Response(JSON.stringify({ error: "Tier/product mismatch" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Guard against a purchase token being replayed against a different
    // account than the one that originally bought it (e.g. a stolen/
    // copied token). This table is one row per user, so an ordinary
    // upsert wouldn't catch this on its own — check explicitly first.
    const { data: existingOwner } = await supabase
      .from("subscriptions")
      .select("user_id")
      .eq("google_play_purchase_token", purchaseToken)
      .neq("user_id", user.id)
      .maybeSingle();

    if (existingOwner) {
      console.error(
        `Purchase token already associated with a different user (requested by ${user.id})`,
      );
      return new Response(
        JSON.stringify({ error: "This purchase is already in use." }),
        { status: 409, headers: corsHeaders },
      );
    }

    const accessToken = await getGoogleAccessToken();

    const verifyRes = await fetch(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptionsv2/tokens/${purchaseToken}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!verifyRes.ok) {
      const errBody = await verifyRes.text();
      console.error(`Play Developer API error (${verifyRes.status}):`, errBody);
      // A purchase token Google doesn't recognize (bad/forged token, or
      // not fully propagated yet) is a "not verified" outcome, not a
      // server error — 200 + status:"failed" so the client shows its
      // normal "could not confirm" message rather than a generic crash.
      return new Response(JSON.stringify({ status: "failed" }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    const purchase = await verifyRes.json();
    console.log("Play purchase verification:", JSON.stringify(purchase));

    const lineItem = purchase.lineItems?.[0];

    if (!lineItem || lineItem.productId !== productId) {
      console.error(
        `Verified purchase productId (${lineItem?.productId}) doesn't match requested productId (${productId})`,
      );
      return new Response(JSON.stringify({ status: "failed" }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    const status = mapSubscriptionState(purchase.subscriptionState);
    const periodEnd = lineItem.expiryTime ?? null;

    if (status === "lapsed" || !periodEnd) {
      // Legitimately not entitled (pending payment, on hold, expired,
      // paused, etc.) — not an error, just not active yet/anymore.
      return new Response(JSON.stringify({ status: "failed" }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // ── Cross-provider conflict check (log only) ─────────
    // create-subscription blocks a NEW Pesapal checkout from starting while
    // an active Google Play subscription exists, which is the main guard.
    // But Google's purchase has already been charged for real by the time
    // we get here — there's no way to "reject" it without a refund, so we
    // always honor it. This is just a visibility flag for support/ops in
    // case a user somehow still had an active Pesapal subscription when
    // this Google Play purchase came in (e.g. they started the Pesapal
    // checkout before this guard existed, or in a narrow race window).
    const { data: existingRow } = await supabase
      .from("subscriptions")
      .select("payment_provider, status, current_period_end")
      .eq("user_id", user.id)
      .maybeSingle();

    const hadActivePesapal =
      existingRow?.payment_provider === "pesapal" &&
      (existingRow.status === "active" || existingRow.status === "cancelled") &&
      existingRow.current_period_end &&
      new Date(existingRow.current_period_end) > new Date();

    if (hadActivePesapal) {
      console.warn(
        `verify-google-purchase: user ${user.id} completed a Google Play purchase while an active Pesapal subscription (period end ${existingRow.current_period_end}) was still on file — overwriting with Google Play as the new source of truth.`,
      );
    }

    await supabase.from("subscriptions").upsert(
      {
        user_id: user.id,
        status,
        tier,
        one_off: false,
        amount: TIER_AMOUNTS[tier] ?? 0,
        currency: "KES",
        payment_provider: "google_play",
        google_play_purchase_token: purchaseToken,
        google_play_product_id: productId,
        google_play_order_id: lineItem.latestSuccessfulOrderId ?? null,
        current_period_start: purchase.startTime ?? new Date().toISOString(),
        current_period_end: periodEnd,
        renewal_reminder_sent: false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

    console.log(
      `Verified Google Play purchase for user ${user.id}: tier=${tier} status=${status} periodEnd=${periodEnd}`,
    );

    return new Response(JSON.stringify({ status: "active" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("verify-google-purchase error:", error.message);
    return new Response(
      JSON.stringify({ error: "Something went wrong. Please try again." }),
      { status: 500, headers: corsHeaders },
    );
  }
});
