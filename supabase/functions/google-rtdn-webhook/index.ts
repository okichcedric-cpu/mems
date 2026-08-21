// Receives Google Play's Real-time Developer Notifications (RTDN) via a
// Pub/Sub push subscription, and keeps `subscriptions` in sync whenever a
// Google Play subscription renews, enters a grace period, gets cancelled,
// goes on hold, or expires — all of which happen silently on Google's side
// with no client-side signal. Without this, `current_period_end` (written
// once at initial purchase time by verify-google-purchase) goes stale the
// moment Google auto-renews the subscription for the next period, and a
// paying Google Play subscriber would incorrectly get downgraded to free
// ~30 days in even though Google is still charging them.
//
// Setup (one-time, in addition to the Play Console/Pub/Sub topic set up in
// Phase 1):
// 1. Deploy this function, then in Google Cloud Console → Pub/Sub →
//    Subscriptions, create a PUSH subscription on the existing RTDN topic,
//    with the push endpoint set to:
//      https://<project-ref>.supabase.co/functions/v1/google-rtdn-webhook?secret=<RTDN_PUSH_SECRET>
// 2. Set the RTDN_PUSH_SECRET function secret (any long random string) —
//    this is the only authenticity check on this endpoint, since verifying
//    Google's own Pub/Sub OIDC push token would need JWK fetching/verification
//    that isn't worth the complexity here. Keep the secret out of source
//    control/logs.
// 3. Play Console → Monetization setup → make sure the RTDN topic name
//    matches the one this push subscription is attached to (should already
//    be done from Phase 1).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

// Must match src/android/package in app.json — see verify-google-purchase's
// PACKAGE_NAME comment for why this is duplicated rather than shared.
const PACKAGE_NAME = "com.cedricodera.Mems";

// Reverse of src/utils/googlePlayBilling.ts's ANDROID_SUBSCRIPTION_SKUS —
// turns a verified purchase's productId back into our own tier name.
const PRODUCT_ID_TO_TIER: Record<string, string> = {
  mems_small_monthly: "small",
  mems_medium_monthly: "medium",
  mems_big_monthly: "big",
};

const TIER_AMOUNTS: Record<string, number> = {
  small: 99,
  medium: 179,
  big: 299,
};

// Identical mapping to verify-google-purchase — kept in sync manually since
// edge functions can't share code across function directories without a
// _shared/ import convention this codebase doesn't otherwise use.
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
    console.error("RTDN: Google token exchange failed:", JSON.stringify(data));
    throw new Error("Could not authenticate with Google Play");
  }
  return data.access_token;
}

serve(async (req) => {
  // Pub/Sub always POSTs — anything else is a stray request.
  if (req.method !== "POST") {
    return new Response("ok", { status: 200 });
  }

  try {
    // Shared-secret check — the only authenticity guard on this public
    // endpoint (see setup notes above for why not full OIDC verification).
    const url = new URL(req.url);
    const secret = url.searchParams.get("secret");
    const expectedSecret = Deno.env.get("RTDN_PUSH_SECRET");
    if (!expectedSecret || !secret || secret !== expectedSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await req.json();
    // Pub/Sub push envelope: { message: { data: base64, messageId,
    // publishTime, attributes? }, subscription }. `data` is itself a
    // base64'd JSON DeveloperNotification.
    const dataB64 = body?.message?.data;
    if (!dataB64) {
      // No message body — e.g. Pub/Sub's subscription verification request.
      return new Response("ok", { status: 200 });
    }

    const decoded = JSON.parse(atob(dataB64));
    console.log("RTDN notification:", JSON.stringify(decoded));

    const subNotification = decoded.subscriptionNotification;
    if (!subNotification?.purchaseToken) {
      // Not a subscription lifecycle event (could be a one-time product
      // notification, voided-purchase notification, or Google's periodic
      // test notification) — nothing for this function to act on.
      return new Response("ok", { status: 200 });
    }

    const { purchaseToken, notificationType } = subNotification;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // We only know the purchaseToken from the notification — find which
    // user this belongs to via the row verify-google-purchase already
    // wrote at initial purchase time.
    const { data: existing } = await supabase
      .from("subscriptions")
      .select("user_id, tier")
      .eq("google_play_purchase_token", purchaseToken)
      .maybeSingle();

    if (!existing) {
      // Notification arrived for a purchase token we have no row for yet.
      // notificationType 4 (SUBSCRIPTION_PURCHASED) is the very first
      // "you just bought this" notification — it commonly arrives before
      // or alongside the client's own verify-google-purchase call, which
      // is what actually writes the row on first purchase. That race is
      // expected and benign, so it's just a log, not a warning.
      // Anything else (a renewal/cancellation/etc. notification for a
      // token we have no record of at all) is more likely a real problem
      // — e.g. a missed initial purchase, or a token mismatch — so that
      // case stays a warning worth noticing in the logs.
      const isInitialPurchaseNotification = notificationType === 4;
      const logFn = isInitialPurchaseNotification ? console.log : console.warn;
      logFn(
        `RTDN: no subscriptions row for purchaseToken ${purchaseToken} (notificationType=${notificationType})${isInitialPurchaseNotification ? " — expected race with verify-google-purchase on first purchase" : ""}`,
      );
      return new Response("ok", { status: 200 });
    }

    // The notification is only a trigger to go check the source of truth —
    // Google's own guidance is to always re-fetch subscriptionsv2.get
    // rather than trust the notification's own fields. This also means we
    // don't need to hand-branch on all ~13 notificationType values:
    // whatever happened (renewed, recovered, on hold, cancelled, expired,
    // revoked...), re-fetching and remapping state handles it the same way
    // verify-google-purchase handles a fresh purchase.
    const accessToken = await getGoogleAccessToken();
    const verifyRes = await fetch(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptionsv2/tokens/${purchaseToken}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!verifyRes.ok) {
      const errBody = await verifyRes.text();
      console.error(
        `RTDN: Play Developer API error (${verifyRes.status}):`,
        errBody,
      );
      // Ack anyway — a permission/config error won't be fixed by Pub/Sub
      // retrying, and Google will send another notification on the next
      // lifecycle event regardless.
      return new Response("ok", { status: 200 });
    }

    const purchase = await verifyRes.json();
    const lineItem = purchase.lineItems?.[0];
    const productId = lineItem?.productId;
    const tier = PRODUCT_ID_TO_TIER[productId] ?? existing.tier;
    const status = mapSubscriptionState(purchase.subscriptionState);
    const periodEnd = lineItem?.expiryTime ?? null;

    if (!periodEnd) {
      console.warn(
        `RTDN: no expiryTime in purchase for token ${purchaseToken} (notificationType=${notificationType})`,
      );
      return new Response("ok", { status: 200 });
    }

    await supabase.from("subscriptions").upsert(
      {
        user_id: existing.user_id,
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
      `RTDN: refreshed subscription for user ${existing.user_id} — status=${status} periodEnd=${periodEnd} (notificationType=${notificationType})`,
    );

    return new Response("ok", { status: 200 });
  } catch (error: any) {
    console.error("google-rtdn-webhook error:", error.message);
    // Still ack with 200 — most errors here (malformed payload, transient
    // Google API issue) won't be fixed by Pub/Sub's retry, and retries on
    // a push subscription can pile up quickly if we keep 500ing.
    return new Response("ok", { status: 200 });
  }
});
