import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { ListObjectsV2Command, S3Client } from "npm:@aws-sdk/client-s3";
import { createClient } from "npm:@supabase/supabase-js";
import { signUnsubscribeToken } from "../_shared/unsubscribe.ts";

// ── "Create your first collection" nudges: push + email ─────────────────
// Run once a day by pg_cron (see docs/push-notifications-setup.md).
//
// PUSH — for each user with a registered Android push token:
//   • nudge #1 once their token is >= 2 calendar days old (Nairobi time)
//   • nudge #2 once their token is >= 7 calendar days old (and #1 went out)
//   • never again after that — or ever, if they already have a collection.
//   "Token age" is when that user first registered on this device, so the
//   same rule covers new signups and long-standing users (whose clock starts
//   the day they update the app and allow notifications).
//
// EMAIL — separate from push, and NOT dependent on push permission: every
// confirmed account with no collection, on the 2nd calendar day after
// signup, gets ONE email with the same message and an unsubscribe link.
// Capped per run (NUDGE_EMAIL_MAX_PER_RUN, default 100) so the first run
// after launch drains the existing-user backlog over several days instead
// of in one burst (email providers rate-limit and daily-cap sending).
//
// A "collection" lives in S3 as objects under `<userId>/`, so existence is
// a one-key S3 listing (the `collections` table only holds optional
// memory-date metadata, not every collection).
//
// Auth: this isn't called by users. The caller must send the shared secret
// in `x-cron-secret` (env NUDGE_CRON_SECRET). POST body / query `dryRun`
// reports who WOULD be notified without sending or writing anything.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000; // Nairobi = UTC+3
const FIRST_NUDGE_AFTER_DAYS = 2;
const SECOND_NUDGE_AFTER_DAYS = 7;
const MAX_NUDGES = 2;

const TITLE = "Every memory deserves a home ❤️";
const BODY =
  "Start your first collection on Mems and keep your favourite moments together.";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const SITE_URL = "https://www.mems-app.com";
const EMAIL_FROM = "Mems <contact@mems-app.com>";
const EMAIL_REPLY_TO = "contact@mems-app.com";

const EMAIL_PAGE_SIZE = 100;
const EMAIL_MAX_PAGES = 20; // bounds work per run: at most 2,000 accounts scanned

// ── Email content ────────────────────────────────────────────────────────
// `unsubscribeUrl` is built server-side from a user id and an HMAC (hex
// only), so interpolating it needs no escaping.
function buildEmailText(unsubscribeUrl: string): string {
  return `
Hi,

${BODY}

Create your first collection: ${SITE_URL}

You received this email because you have a Mems account.
Unsubscribe from these reminders: ${unsubscribeUrl}

— The Mems Team
`.trim();
}

function buildEmailHtml(unsubscribeUrl: string): string {
  return `
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

          <tr>
            <td style="background:#111111;padding:28px 32px;text-align:center;">
              <p style="margin:0;font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">Mems</p>
              <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.6);font-style:italic;">
                Your life's best moments, all in one place.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 12px;font-size:22px;font-weight:700;color:#111111;">
                ${TITLE}
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#555555;line-height:24px;">
                ${BODY}
              </p>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#111111;border-radius:12px;">
                    <a href="${SITE_URL}"
                      style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">
                      Create your first collection →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="background:#f9f9f9;padding:20px 32px;border-top:1px solid #eeeeee;">
              <p style="margin:0;font-size:12px;color:#bbbbbb;line-height:18px;text-align:center;">
                You received this email because you have a Mems account.<br/>
                <a href="${unsubscribeUrl}" style="color:#999999;">Unsubscribe from these reminders</a><br/><br/>
                <a href="${SITE_URL}" style="color:#999999;">mems-app.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Constant-time-ish comparison so the secret check doesn't leak length/
// prefix timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const expected = Deno.env.get("NUDGE_CRON_SECRET");
    const provided = req.headers.get("x-cron-secret") ?? "";
    if (!expected || !safeEqual(provided, expected)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    let dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
    try {
      const body = await req.json();
      if (body?.dryRun === true) dryRun = true;
    } catch {
      // no body — fine
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabase = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const s3 = new S3Client({
      region: Deno.env.get("AWS_REGION")!,
      credentials: {
        accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
        secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
      },
    });
    const bucket = Deno.env.get("S3_BUCKET")!;
    const nowIso = new Date().toISOString();

    // ── Shared: "does this user own any collection?" ─────────────
    // One-key S3 listing, cached per run (a user can be in both the push
    // and email phases). Returns null if S3 couldn't be reached: callers
    // treat that as "unknown" and skip the user (fail closed).
    const collectionCache = new Map<string, boolean | null>();
    async function checkHasCollection(userId: string): Promise<boolean | null> {
      if (collectionCache.has(userId)) return collectionCache.get(userId)!;
      let result: boolean | null;
      try {
        const res = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${userId}/`,
            MaxKeys: 1,
          }),
        );
        result = (res.KeyCount ?? 0) > 0;
      } catch (e: any) {
        console.warn(`S3 check failed for ${userId}:`, e?.message);
        result = null;
      }
      collectionCache.set(userId, result);
      return result;
    }
    async function checkMany(userIds: string[]): Promise<void> {
      for (let i = 0; i < userIds.length; i += 10) {
        await Promise.all(userIds.slice(i, i + 10).map(checkHasCollection));
      }
    }

    // Users found to already have a collection: finished for BOTH channels.
    async function markHaveCollection(userIds: string[]) {
      if (dryRun || userIds.length === 0) return;
      await supabase.from("collection_nudges").upsert(
        userIds.map((user_id) => ({
          user_id,
          nudge_count: MAX_NUDGES,
          email_skipped_at: nowIso,
        })),
        { onConflict: "user_id" },
      );
    }

    // ═════════════════════════ PUSH PHASE ═════════════════════════
    // ── 1. Load all Android tokens, page by page ─────────────────
    const tokens: { token: string; user_id: string; created_at: string }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("push_tokens")
        .select("token, user_id, created_at")
        .eq("platform", "android")
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      tokens.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }

    // Group per user; the user's clock is their OLDEST token's age.
    const byUser = new Map<string, { tokens: string[]; firstSeen: number }>();
    for (const t of tokens) {
      const ts = new Date(t.created_at).getTime();
      const entry = byUser.get(t.user_id);
      if (entry) {
        entry.tokens.push(t.token);
        entry.firstSeen = Math.min(entry.firstSeen, ts);
      } else {
        byUser.set(t.user_id, { tokens: [t.token], firstSeen: ts });
      }
    }

    // ── 2. Existing nudge counts ─────────────────────────────────
    const userIds = [...byUser.keys()];
    const nudgeCount = new Map<string, number>();
    for (let i = 0; i < userIds.length; i += 500) {
      const { data, error } = await supabase
        .from("collection_nudges")
        .select("user_id, nudge_count")
        .in("user_id", userIds.slice(i, i + 500));
      if (error) throw new Error(error.message);
      for (const row of data ?? []) nudgeCount.set(row.user_id, row.nudge_count);
    }

    // ── 3. Which users are due ───────────────────────────────────
    // Calendar days in Nairobi time (UTC+3), not 48-hour blocks: someone
    // who registered at 6pm on day 0 still gets the 8pm run on day 2,
    // rather than missing it by an hour and waiting for day 3.
    const now = Date.now();
    const eatDay = (ts: number) => Math.floor((ts + EAT_OFFSET_MS) / DAY_MS);
    const due: string[] = [];
    for (const [userId, info] of byUser) {
      const count = nudgeCount.get(userId) ?? 0;
      if (count >= MAX_NUDGES) continue;
      const ageDays = eatDay(now) - eatDay(info.firstSeen);
      const neededDays =
        count === 0 ? FIRST_NUDGE_AFTER_DAYS : SECOND_NUDGE_AFTER_DAYS;
      if (ageDays >= neededDays) due.push(userId);
    }

    // ── 4. Drop anyone who already has a collection ──────────────
    await checkMany(due);
    const pushEligible = due.filter((id) => collectionCache.get(id) === false);
    await markHaveCollection(due.filter((id) => collectionCache.get(id) === true));

    // ── 5. Send via Expo's push API (max 100 messages per request) ──
    const notifiedUsers = new Set<string>();
    const deadTokens: string[] = [];
    if (!dryRun) {
      const messages: { to: string; userId: string }[] = [];
      for (const userId of pushEligible) {
        for (const to of byUser.get(userId)!.tokens) messages.push({ to, userId });
      }
      const accessToken = Deno.env.get("EXPO_ACCESS_TOKEN");

      for (let i = 0; i < messages.length; i += 100) {
        const chunk = messages.slice(i, i + 100);
        const res = await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify(
            chunk.map((m) => ({
              to: m.to,
              title: TITLE,
              body: BODY,
              sound: "default",
              channelId: "default",
              data: { type: "collection_nudge" },
            })),
          ),
        });

        if (!res.ok) {
          console.error("Expo push request failed:", res.status, await res.text());
          continue;
        }
        const { data: tickets } = await res.json();
        (tickets ?? []).forEach((ticket: any, idx: number) => {
          const msg = chunk[idx];
          if (ticket?.status === "ok") {
            notifiedUsers.add(msg.userId);
          } else if (ticket?.details?.error === "DeviceNotRegistered") {
            deadTokens.push(msg.to);
          } else {
            console.warn("Push ticket error:", JSON.stringify(ticket));
          }
        });
      }

      // ── 6. Record sends, prune dead tokens ─────────────────────
      if (notifiedUsers.size > 0) {
        await supabase.from("collection_nudges").upsert(
          [...notifiedUsers].map((user_id) => ({
            user_id,
            nudge_count: (nudgeCount.get(user_id) ?? 0) + 1,
            last_nudged_at: nowIso,
          })),
          { onConflict: "user_id" },
        );
      }
      if (deadTokens.length > 0) {
        await supabase.from("push_tokens").delete().in("token", deadTokens);
      }
    }

    // ═════════════════════════ EMAIL PHASE ═════════════════════════
    // Best-effort and independent of push: any failure is logged and
    // retried on the next run (email_sent_at is only written on success),
    // and never affects the push results above.
    const emailCap = Math.max(
      1,
      parseInt(Deno.env.get("NUDGE_EMAIL_MAX_PER_RUN") ?? "100", 10) || 100,
    );
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const canSignLinks = !!Deno.env.get("UNSUBSCRIBE_SECRET");

    // ── 7. Collect up to `emailCap` accounts that need the email ──
    // Candidates come from a SQL function (all confirmed accounts past
    // their 2nd calendar day, not yet emailed/skipped/unsubscribed).
    // Accounts that turn out to own a collection are marked as skipped,
    // which removes them from the candidate list — so in a real run the
    // list shrinks as we go and offset only needs to advance past rows that
    // stay (no collection, or S3 unreachable). In a dry run nothing is
    // marked, so offset advances past everything instead.
    const toEmail: { userId: string; email: string }[] = [];
    let skippedHaveCollectionEmail = 0;
    let offset = 0;
    let pagesScanned = 0;
    for (let page = 0; page < EMAIL_MAX_PAGES && toEmail.length < emailCap; page++) {
      const { data: rows, error } = await supabase.rpc(
        "get_nudge_email_candidates",
        { p_limit: EMAIL_PAGE_SIZE, p_offset: offset },
      );
      if (error) throw new Error(`get_nudge_email_candidates: ${error.message}`);
      if (!rows || rows.length === 0) break;
      pagesScanned++;

      await checkMany(rows.map((r: any) => r.user_id));
      const owners: string[] = [];
      let staying = 0;
      for (const r of rows as { user_id: string; email: string }[]) {
        const has = collectionCache.get(r.user_id);
        if (has === true) {
          owners.push(r.user_id);
        } else {
          staying++;
          if (has === false && toEmail.length < emailCap) {
            toEmail.push({ userId: r.user_id, email: r.email });
          }
        }
      }
      skippedHaveCollectionEmail += owners.length;
      await markHaveCollection(owners);
      offset += dryRun ? rows.length : staying;
      if (rows.length < EMAIL_PAGE_SIZE) break;
    }

    if (dryRun) {
      return jsonResponse({
        dryRun: true,
        pushTotalUsersWithTokens: byUser.size,
        pushDue: due.length,
        pushWouldNotify: pushEligible.length,
        emailWouldSend: toEmail.length,
        emailPerRunCap: emailCap,
        emailPagesScanned: pagesScanned,
        emailCanSign: canSignLinks,
        emailResendConfigured: !!resendKey,
      });
    }

    // ── 8. Send the emails ───────────────────────────────────────
    let emailed = 0;
    let emailFailed = 0;
    if (toEmail.length > 0 && (!resendKey || !canSignLinks)) {
      // Never send without a working unsubscribe link.
      console.warn(
        "Skipping nudge emails: RESEND_API_KEY or UNSUBSCRIBE_SECRET is not set",
      );
    } else if (toEmail.length > 0) {
      const authHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendKey}`,
      };

      // Build each recipient's email (link is unique to the recipient).
      const prepared = await Promise.all(
        toEmail.map(async (r) => {
          const token = await signUnsubscribeToken(r.userId);
          const q = `u=${r.userId}&t=${token}`;
          const pageUrl = `${SITE_URL}/unsubscribe?${q}`;
          const oneClickUrl = `${supabaseUrl}/functions/v1/unsubscribe-nudge?${q}`;
          return {
            userId: r.userId,
            payload: {
              from: EMAIL_FROM,
              reply_to: EMAIL_REPLY_TO,
              to: [r.email],
              subject: TITLE,
              text: buildEmailText(pageUrl),
              html: buildEmailHtml(pageUrl),
              // Lets Gmail/Apple Mail show their own Unsubscribe button.
              headers: {
                "List-Unsubscribe": `<${oneClickUrl}>, <mailto:${EMAIL_REPLY_TO}?subject=unsubscribe>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
            },
          };
        }),
      );

      const markSent = async (ids: string[]) => {
        if (ids.length === 0) return;
        // Only this column: an upsert touches just what it's given, so
        // nudge_count etc. written earlier are left alone.
        await supabase.from("collection_nudges").upsert(
          ids.map((user_id) => ({ user_id, email_sent_at: nowIso })),
          { onConflict: "user_id" },
        );
      };

      for (let i = 0; i < prepared.length; i += 100) {
        const chunk = prepared.slice(i, i + 100);
        let batchOk = false;
        try {
          const res = await fetch("https://api.resend.com/emails/batch", {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify(chunk.map((c) => c.payload)),
          });
          if (res.ok) {
            batchOk = true;
          } else {
            console.warn("Resend batch failed:", res.status, await res.text());
          }
        } catch (e: any) {
          console.warn("Resend batch error:", e?.message);
        }

        if (batchOk) {
          await markSent(chunk.map((c) => c.userId));
          emailed += chunk.length;
          continue;
        }

        // The whole batch is rejected if any one address is invalid, so
        // fall back to one-by-one (spaced out to stay under Resend's
        // default 2 requests/second) so one bad address can't block the
        // rest. A permanent rejection (4xx other than rate-limit) marks
        // that account as skipped so it isn't retried forever.
        for (const c of chunk) {
          try {
            const res = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: authHeaders,
              body: JSON.stringify(c.payload),
            });
            if (res.ok) {
              await markSent([c.userId]);
              emailed++;
            } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
              console.warn(`Permanent email failure for ${c.userId}:`, res.status);
              await supabase.from("collection_nudges").upsert(
                { user_id: c.userId, email_skipped_at: nowIso },
                { onConflict: "user_id" },
              );
              emailFailed++;
            } else {
              emailFailed++; // 429 / 5xx: retried on the next run
            }
          } catch (e: any) {
            console.warn("Resend send error:", e?.message);
            emailFailed++;
          }
          await sleep(550);
        }
      }
    }

    return jsonResponse({
      pushTotalUsersWithTokens: byUser.size,
      pushDue: due.length,
      pushNotified: notifiedUsers.size,
      removedDeadTokens: deadTokens.length,
      emailed,
      emailFailed,
      emailSkippedHaveCollection: skippedHaveCollectionEmail,
    });
  } catch (error: any) {
    console.error("send-collection-nudge error:", error?.message);
    return jsonResponse({ error: error?.message ?? "Unknown error" }, 500);
  }
});
