import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Loose but sane RFC-5322-ish check — this only guards against the field
// being used to smuggle arbitrary content, not full spec validation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.cedricodera.Mems";

// Google's own CDN-hosted "Get it on Google Play" badge — referencing
// their asset directly means no hosting on our side and it always stays
// in line with Google's branding guidelines.
const PLAY_STORE_BADGE_URL =
  "https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png";

// Escape values before they're interpolated into the HTML email body.
// recipientEmail/collectionName ultimately trace back to user input
// (collection names are user-chosen, emails come from the share form),
// so without this an attacker could inject markup/script-bearing tags
// into an email sent from our domain.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Auth check ────────────────────────────────────────────────
    // Without this, anyone holding the (public) anon key could call this
    // function directly and use it as an open relay to send arbitrary
    // "Mems" branded email to any address.
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

    if (authError || !user || !user.email) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const { recipientEmail, collectionName, photoKey } = await req.json();

    if (!recipientEmail || typeof recipientEmail !== "string" || !EMAIL_RE.test(recipientEmail)) {
      return new Response(JSON.stringify({ error: "Invalid recipient email" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (!collectionName || typeof collectionName !== "string") {
      return new Response(JSON.stringify({ error: "Missing collection name" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // ── Single photo vs whole collection ────────────────────────────
    // An optional `photoKey` in the body is what distinguishes the two —
    // present means "confirm+send for a single-photo share" (checked
    // against shared_photos, scoped to that exact key), absent means the
    // original whole-collection flow (checked against shared_collections).
    // Kept as one function rather than two near-duplicates since the only
    // real differences are which table gets the existence check and a
    // handful of words in the copy below.
    const isPhotoShare = typeof photoKey === "string" && photoKey.length > 0;

    // ── Ownership derived from the verified JWT, never from the request
    // body ── prevents a caller from impersonating a different "sharer"
    // in the email content.
    const ownerEmail = user.email;
    const normalisedRecipient = recipientEmail.trim().toLowerCase();

    // ── Confirm a real share exists before sending ─────────────────
    // Ties this function to an actual shareCollection()/sharePhoto() call
    // (which inserts the row first) rather than letting it be used as a
    // standalone mailer for arbitrary owner/recipient pairs.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: share } = isPhotoShare
      ? await supabase
          .from("shared_photos")
          .select("id")
          .eq("owner_id", user.id)
          .eq("photo_key", photoKey)
          .eq("recipient_email", normalisedRecipient)
          .maybeSingle()
      : await supabase
          .from("shared_collections")
          .select("id")
          .eq("owner_id", user.id)
          .eq("collection_name", collectionName)
          .eq("recipient_email", normalisedRecipient)
          .maybeSingle();

    if (!share) {
      return new Response(JSON.stringify({ error: "No matching share found" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    const safeOwnerEmail = escapeHtml(ownerEmail);
    const safeRecipientEmail = escapeHtml(normalisedRecipient);
    const safeCollectionName = escapeHtml(collectionName);

    // ── Copy that differs between the two share types ───────────────
    // Everything else in the template (header, Play Store badge, footer
    // shell) is identical either way.
    const subject = isPhotoShare
      ? `${ownerEmail} shared a photo with you`
      : `${ownerEmail} shared a photo collection with you`;

    const textBody = isPhotoShare
      ? `
Hi,

${ownerEmail} has shared a photo with you on Mems, from their "${collectionName}" album.

View it on the web at https://www.mems-app.com, or get the Android app on Google Play: ${PLAY_STORE_URL}

You received this email because someone shared a Mems photo with your email address.
If you did not expect this, you can safely ignore it.

— The Mems Team
        `.trim()
      : `
Hi,

${ownerEmail} has shared a photo collection called "${collectionName}" with you on Mems.

View it on the web at https://www.mems-app.com, or get the Android app on Google Play: ${PLAY_STORE_URL}

You received this email because someone shared a Mems collection with your email address.
If you did not expect this, you can safely ignore it.

— The Mems Team
        `.trim();

    const introLine = isPhotoShare
      ? `<strong>${safeOwnerEmail}</strong> has shared a photo with you.`
      : `<strong>${safeOwnerEmail}</strong> has shared a photo collection with you.`;

    const cardLabel = isPhotoShare ? "From the album" : "Collection";
    const ctaLabel = isPhotoShare ? "View Photo →" : "View Collection →";
    const footerVerb = isPhotoShare ? "photo" : "collection";

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
      },
      body: JSON.stringify({
        // ── Use your verified domain address ──
        from: "Mems <contact@mems-app.com>",

        // ── Reply-To gives recipients a real address to respond to ──
        reply_to: "contact@mems-app.com",

        to: [normalisedRecipient],

        subject,

        // ── Plain text version — required to avoid spam ──
        text: textBody,

        // ── HTML version ──
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;max-width:560px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:#111111;padding:28px 32px;text-align:center;">
              <p style="margin:0;font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
                Mems
              </p>
              <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.6);font-style:italic;">
                Your life's best moments, all in one place.
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111111;">
                📸 You've been invited!
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#555555;line-height:24px;">
                ${introLine}
              </p>

              <!-- Collection/album card -->
              <table width="100%" cellpadding="0" cellspacing="0"
                style="background:#f9f9f9;border:1px solid #eeeeee;border-radius:12px;margin-bottom:24px;">
                <tr>
                  <td style="padding:20px;">
                    <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#999999;
                      text-transform:uppercase;letter-spacing:0.5px;">
                      ${cardLabel}
                    </p>
                    <p style="margin:0;font-size:20px;font-weight:800;color:#111111;">
                      ${safeCollectionName}
                    </p>
                  </td>
                </tr>
              </table>

              <!-- CTA button -->
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#111111;border-radius:12px;">
                    <a href="https://www.mems-app.com"
                      style="display:inline-block;padding:14px 28px;font-size:15px;
                        font-weight:600;color:#ffffff;text-decoration:none;">
                      ${ctaLabel}
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 12px;font-size:13px;color:#999999;line-height:20px;">
                Or get the Android app and it'll appear in your home screen.
              </p>

              <a href="${PLAY_STORE_URL}" style="display:inline-block;">
                <img
                  src="${PLAY_STORE_BADGE_URL}"
                  alt="Get it on Google Play"
                  width="150"
                  height="58"
                  style="display:block;border:0;width:150px;height:58px;"
                />
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9f9f9;padding:20px 32px;border-top:1px solid #eeeeee;">
              <p style="margin:0;font-size:12px;color:#bbbbbb;line-height:18px;text-align:center;">
                You received this because ${safeOwnerEmail} shared a Mems ${footerVerb} with
                ${safeRecipientEmail}.<br/>
                If you did not expect this email you can safely ignore it.<br/><br/>
                <a href="https://www.mems-app.com" style="color:#999999;">mems-app.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
        `,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Resend error:", JSON.stringify(data));
      throw new Error(data.message ?? "Failed to send email");
    }

    console.log("Share email sent:", data.id);

    return new Response(JSON.stringify({ success: true, id: data.id }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("send-share-email error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});