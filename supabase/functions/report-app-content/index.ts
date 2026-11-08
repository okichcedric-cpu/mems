import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js";

// In-app report / feedback from the mobile app. Signed-in users only.
//   { context: 'collection'|'photo'|'general', reason, details?,
//     ownerId?, collectionName? }
// Saved to app_reports and emailed to contact@mems-app.com (REPORTS_TO).

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
const REASONS: Record<string, string> = {
  child_safety: "Child safety concern",
  sexual_content: "Sexual or explicit content",
  violence_hate: "Violence, hate or harassment",
  harassment: "Bullying or harassment of me",
  privacy: "Privacy (people shown without consent)",
  spam_scam: "Spam or scam",
  feedback: "General feedback / other",
};
const CONTEXTS = new Set(["collection", "photo", "general"]);
const MAX_PER_HOUR = 10;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Please sign in to send a report." }, 401);
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: { user } } = await anon.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Please sign in to send a report." }, 401);

    const body = await req.json().catch(() => ({}));
    const context = String(body.context ?? "");
    const reason = String(body.reason ?? "");
    const details = typeof body.details === "string" ? body.details.trim().slice(0, 1500) : "";
    const ownerId = typeof body.ownerId === "string" && UUID.test(body.ownerId) ? body.ownerId : null;
    const collectionName = typeof body.collectionName === "string"
      ? body.collectionName.trim().slice(0, 80) : null;

    if (!CONTEXTS.has(context)) return json({ error: "Invalid report." }, 400);
    if (!REASONS[reason]) return json({ error: "Please choose a reason." }, 400);
    if (reason === "feedback" && details.length < 3) {
      return json({ error: "Please tell us a little more." }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from("app_reports")
      .select("id", { count: "exact", head: true })
      .eq("reporter_id", user.id).gte("created_at", since);
    if ((count ?? 0) >= MAX_PER_HOUR) {
      return json({ error: "You've sent several reports recently. Please try again later." }, 429);
    }

    const { data: report, error } = await admin.from("app_reports").insert({
      reporter_id: user.id,
      reporter_email: user.email ?? null,
      context,
      owner_id: ownerId,
      collection_name: collectionName,
      reason,
      details,
    }).select("id").single();
    if (error || !report) return json({ error: "Could not send your report. Please try again." }, 500);

    let ownerEmail = "";
    if (ownerId) {
      const { data } = await admin.auth.admin.getUserById(ownerId);
      ownerEmail = data?.user?.email ?? "";
    }

    const urgent = reason === "child_safety";
    const html = `
      <h3>In-app report${urgent ? " — URGENT (child safety)" : ""}</h3>
      <p><strong>Type:</strong> ${escapeHtml(context)}<br>
      <strong>Reason:</strong> ${escapeHtml(REASONS[reason])}<br>
      <strong>Collection:</strong> ${escapeHtml(collectionName ?? "—")}<br>
      <strong>Content owner:</strong> ${escapeHtml(ownerEmail || ownerId || "—")}<br>
      <strong>Reporter:</strong> ${escapeHtml(user.email ?? user.id)}</p>
      <p><strong>Details:</strong><br>${escapeHtml(details || "(none)").replace(/\n/g, "<br>")}</p>
      <hr><p style="font-size:12px;color:#555">Report ${report.id}<br>
      Close it: <code>update public.app_reports set status = 'actioned', reviewed_at = now() where id = '${report.id}';</code></p>`;

    const key = Deno.env.get("RESEND_API_KEY");
    if (key) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: Deno.env.get("MARKETPLACE_EMAIL_FROM") ?? "Picture Board <hello@mems-app.com>",
          to: Deno.env.get("REPORTS_TO") ?? "contact@mems-app.com",
          subject: `${urgent ? "[URGENT] " : ""}App report: ${REASONS[reason]}`.slice(0, 200),
          html,
          ...(user.email ? { reply_to: user.email } : {}),
        }),
      });
      if (!res.ok) console.error("report email failed", res.status, await res.text());
    } else {
      console.error("RESEND_API_KEY missing: report saved but not emailed", report.id);
    }
    return json({ ok: true });
  } catch (e) {
    console.error("report-app-content error:", (e as Error).message);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
