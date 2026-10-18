import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { ListObjectsV2Command, S3Client } from "npm:@aws-sdk/client-s3";
import { createClient } from "npm:@supabase/supabase-js";

// ── "Create your first collection" push nudges ──────────────────────────
// Run once a day by pg_cron (see the setup guide). For each user with a
// registered Android push token:
//   • nudge #1 once their token is >= 2 days old
//   • nudge #2 once their token is >= 7 days old (and #1 has gone out)
//   • never again after that — or ever, if they already have a collection.
// "Token age" is when that user first registered on this device, so the
// same rule covers new signups and long-standing users (whose clock starts
// the day they update the app and allow notifications).
//
// A "collection" lives in S3 as objects under `<userId>/`, so existence is
// a one-key S3 listing (the `collections` table only holds optional
// memory-date metadata, not every collection).
//
// Auth: this isn't called by users. The caller must send the shared secret
// in `x-cron-secret` (env NUDGE_CRON_SECRET). POST body / query `dryRun`
// returns who WOULD be notified without sending anything.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_NUDGE_AFTER_DAYS = 2;
const SECOND_NUDGE_AFTER_DAYS = 7;
const MAX_NUDGES = 2;

const TITLE = "Every memory deserves a home ❤️";
const BODY =
  "Start your first collection on Mems and keep your favourite moments together.";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
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
    const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
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
    // Done in small parallel batches. Users who do are marked finished so
    // they are never checked (or nudged) again.
    const eligible: string[] = [];
    const alreadyHaveCollection: string[] = [];
    for (let i = 0; i < due.length; i += 10) {
      const batch = due.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(async (userId) => {
          try {
            const res = await s3.send(
              new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: `${userId}/`,
                MaxKeys: 1,
              }),
            );
            return { userId, has: (res.KeyCount ?? 0) > 0, failed: false };
          } catch (e: any) {
            console.warn(`S3 check failed for ${userId}:`, e?.message);
            // Fail closed: when unsure, don't notify.
            return { userId, has: true, failed: true };
          }
        }),
      );
      for (const r of results) {
        if (r.failed) continue;
        (r.has ? alreadyHaveCollection : eligible).push(r.userId);
      }
    }

    if (!dryRun && alreadyHaveCollection.length > 0) {
      await supabase.from("collection_nudges").upsert(
        alreadyHaveCollection.map((user_id) => ({
          user_id,
          nudge_count: MAX_NUDGES,
        })),
        { onConflict: "user_id" },
      );
    }

    if (dryRun) {
      return jsonResponse({
        dryRun: true,
        totalUsersWithTokens: byUser.size,
        due: due.length,
        wouldNotify: eligible.length,
        skippedHaveCollection: alreadyHaveCollection.length,
      });
    }

    // ── 5. Send via Expo's push API (max 100 messages per request) ──
    const messages: { to: string; userId: string }[] = [];
    for (const userId of eligible) {
      for (const to of byUser.get(userId)!.tokens) messages.push({ to, userId });
    }

    const notifiedUsers = new Set<string>();
    const deadTokens: string[] = [];
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

    // ── 6. Record sends, prune dead tokens ───────────────────────
    const nowIso = new Date().toISOString();
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

    return jsonResponse({
      totalUsersWithTokens: byUser.size,
      due: due.length,
      notified: notifiedUsers.size,
      skippedHaveCollection: alreadyHaveCollection.length,
      removedDeadTokens: deadTokens.length,
    });
  } catch (error: any) {
    console.error("send-collection-nudge error:", error?.message);
    return jsonResponse({ error: error?.message ?? "Unknown error" }, 500);
  }
});
