import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

// Report a marketplace listing (or one of its public preview photos).
// Open to signed-out visitors too. Stores the report and emails it to
// contact@mems-app.com. Body:
//   { listingId, reason, details?, photoIndex?, email? }
//
// Abuse controls: per-reporter rate limit, one open report per reporter per
// listing/photo, and size limits. Child-safety reports immediately hide the
// listing (status 'removed') until a human has reviewed it.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REASONS: Record<string, string> = {
  child_safety: "Child safety",
  sexual_content: "Sexual or explicit content",
  violence_hate: "Violence, hate or harassment",
  copyright: "Copyright / not the seller's work",
  privacy: "Privacy (people shown without consent)",
  scam_misleading: "Scam or misleading",
  other: "Something else",
};
const MAX_PER_HOUR = 5;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const listingId = String(body.listingId ?? "");
    const reason = String(body.reason ?? "");
    const details = typeof body.details === "string" ? body.details.trim().slice(0, 1000) : "";
    const photoIndex = Number.isInteger(body.photoIndex) ? body.photoIndex : null;
    const emailInput = typeof body.email === "string" ? body.email.trim().slice(0, 200) : "";

    if (!UUID.test(listingId)) return json({ error: "Invalid listing." }, 400);
    if (!REASONS[reason]) return json({ error: "Please choose a reason." }, 400);
    if (emailInput && !EMAIL.test(emailInput)) {
      return json({ error: "That email address doesn't look right." }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Who is reporting (optional). A bad/expired token just means anonymous.
    let reporterId: string | null = null;
    let reporterEmail: string | null = emailInput || null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      const anon = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
      );
      const { data: { user } } = await anon.auth.getUser(authHeader.replace("Bearer ", ""));
      if (user) {
        reporterId = user.id;
        reporterEmail = user.email ?? reporterEmail;
      }
    }

    // Rate-limit key: signed-in user id, else hashed IP (never stored raw).
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const salt = Deno.env.get("UNSUBSCRIBE_SECRET") ?? "mems-reports";
    const reporterKey = await sha256Hex(`${salt}:${reporterId ?? ip}`);

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recent } = await admin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .eq("reporter_key", reporterKey)
      .gte("created_at", since);
    if ((recent ?? 0) >= MAX_PER_HOUR) {
      return json({ error: "You've sent several reports recently. Please try again later." }, 429);
    }

    const { data: listing } = await admin
      .from("listings")
      .select("id, title, seller_id, collection_name, status, preview_count")
      .eq("id", listingId)
      .maybeSingle();
    // Don't reveal unpublished listings; "removed" ones may still be reported.
    if (!listing || listing.status === "unpublished") {
      return json({ error: "This listing is no longer available." }, 404);
    }
    if (photoIndex !== null && (photoIndex < 0 || photoIndex >= listing.preview_count)) {
      return json({ error: "Invalid photo." }, 400);
    }

    // One report per reporter per listing/photo.
    let dup = admin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .eq("reporter_key", reporterKey)
      .eq("listing_id", listingId);
    dup = photoIndex === null ? dup.is("photo_index", null) : dup.eq("photo_index", photoIndex);
    const { count: already } = await dup;
    if ((already ?? 0) > 0) return json({ ok: true, duplicate: true });

    const { data: report, error: insertError } = await admin
      .from("reports")
      .insert({
        listing_id: listingId,
        listing_title: listing.title,
        seller_id: listing.seller_id,
        photo_index: photoIndex,
        reason,
        details,
        reporter_id: reporterId,
        reporter_email: reporterEmail,
        reporter_key: reporterKey,
      })
      .select("id")
      .single();
    if (insertError || !report) return json({ error: "Could not send your report. Please try again." }, 500);

    // Child-safety: hide immediately, pending human review.
    let autoHidden = false;
    if (reason === "child_safety" && listing.status === "published") {
      const { error } = await admin.from("listings").update({ status: "removed" }).eq("id", listingId);
      autoHidden = !error;
    }

    // Email the team.
    const { data: seller } = await admin
      .from("creator_profiles")
      .select("handle, display_name")
      .eq("user_id", listing.seller_id)
      .maybeSingle();
    const origin = (Deno.env.get("MARKETPLACE_ORIGIN") ?? "https://marketplace.mems-app.com").replace(/\/+$/, "");
    const link = `${origin}/listing/${listing.id}`;
    const target = photoIndex === null ? "the whole listing" : `preview photo #${photoIndex + 1}`;

    const html = `
      <h3>Marketplace report${autoHidden ? " — AUTO-HIDDEN (child safety)" : ""}</h3>
      <p><strong>Reason:</strong> ${escapeHtml(REASONS[reason])}<br>
      <strong>About:</strong> ${escapeHtml(target)}<br>
      <strong>Listing:</strong> <a href="${link}">${escapeHtml(listing.title)}</a><br>
      <strong>Seller:</strong> ${escapeHtml(seller?.display_name ?? "?")} (@${escapeHtml(seller?.handle ?? "?")})<br>
      <strong>Reporter:</strong> ${escapeHtml(reporterEmail ?? "anonymous")}${reporterId ? " (signed in)" : ""}</p>
      <p><strong>Details:</strong><br>${escapeHtml(details || "(none)").replace(/\n/g, "<br>")}</p>
      <hr>
      <p style="font-size:12px;color:#555">
      Report ${report.id}<br>
      Take the listing down (Supabase SQL editor):<br>
      <code>update public.listings set status = 'removed' where id = '${listing.id}';</code><br>
      Suspend the seller:<br>
      <code>update public.creator_profiles set status = 'suspended' where user_id = '${listing.seller_id}';</code><br>
      Close the report:<br>
      <code>update public.reports set status = 'actioned', reviewed_at = now() where id = '${report.id}';</code>
      (or 'dismissed')</p>`;

    const key = Deno.env.get("RESEND_API_KEY");
    if (key) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: Deno.env.get("MARKETPLACE_EMAIL_FROM") ?? "Mems <hello@mems-app.com>",
          to: Deno.env.get("REPORTS_TO") ?? "contact@mems-app.com",
          subject: `${autoHidden ? "[URGENT] " : ""}Marketplace report: ${REASONS[reason]} — ${listing.title}`.slice(0, 200),
          html,
          ...(reporterEmail ? { reply_to: reporterEmail } : {}),
        }),
      });
      if (!res.ok) console.error("report email failed", res.status, await res.text());
    } else {
      console.error("RESEND_API_KEY missing: report saved but not emailed", report.id);
    }

    return json({ ok: true });
  } catch (e) {
    console.error("report-content error:", (e as Error).message);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
