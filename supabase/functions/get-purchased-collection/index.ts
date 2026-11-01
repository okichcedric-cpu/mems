import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { ListObjectsV2Command, S3Client } from "npm:@aws-sdk/client-s3";
import { createClient } from "npm:@supabase/supabase-js";
import { signedReadUrl } from "../_shared/cdn.ts";

// Delivers a purchased collection: full-resolution signed URLs, but ONLY to
// the buyer of a PAID order. A refunded/pending/failed order gets nothing.
// Body: { orderId }

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const orderId = body?.orderId;

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── list: the caller's paid purchases with a cover thumbnail each ───
    // Used by the app's home screen so purchased collections appear there.
    if (body?.action === "list") {
      const { data: orders } = await admin
        .from("orders")
        .select("id, seller_id, collection_name, title, paid_at")
        .eq("buyer_id", user.id)
        .eq("status", "paid")
        .order("paid_at", { ascending: false })
        .limit(50);

      const s3l = new S3Client({
        region: Deno.env.get("AWS_REGION")!,
        credentials: {
          accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
          secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
        },
      });
      const bucketL = Deno.env.get("S3_BUCKET")!;
      const purchases = await Promise.all(
        (orders ?? []).map(async (o: any) => {
          let coverUrls: string[] = [];
          try {
            const r = await s3l.send(new ListObjectsV2Command({
              Bucket: bucketL,
              Prefix: `${o.seller_id}/${o.collection_name}/thumbs/`,
              MaxKeys: 3,
            }));
            const keys = (r.Contents ?? []).map((c) => c.Key).filter(Boolean) as string[];
            coverUrls = await Promise.all(
              keys.map((k) => signedReadUrl(s3l, bucketL, k, 86400)),
            );
          } catch (_) { /* no cover */ }
          return {
            id: o.id,
            title: o.title,
            paidAt: o.paid_at,
            coverUrl: coverUrls[0] ?? null,
            coverUrls,
          };
        }),
      );
      return json({ purchases });
    }

    if (typeof orderId !== "string" || !UUID.test(orderId)) {
      return json({ error: "Invalid order." }, 400);
    }
    const { data: order } = await admin
      .from("orders")
      .select("id, buyer_id, seller_id, collection_name, title, status, paid_at")
      .eq("id", orderId)
      .maybeSingle();

    if (!order || order.buyer_id !== user.id) return json({ error: "Order not found." }, 404);
    if (order.status !== "paid") return json({ error: "This purchase isn't active." }, 403);

    const s3 = new S3Client({
      region: Deno.env.get("AWS_REGION")!,
      credentials: {
        accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
        secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
      },
    });
    const bucket = Deno.env.get("S3_BUCKET")!;
    const prefix = `${order.seller_id}/${order.collection_name}/`;

    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }));
      for (const o of res.Contents ?? []) {
        if (o.Key && !o.Key.includes("/thumbs/") && !o.Key.endsWith("/")) keys.push(o.Key);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    keys.sort();

    const photos = await Promise.all(
      keys.map(async (key) => {
        const i = key.lastIndexOf("/");
        const thumbKey = `${key.slice(0, i)}/thumbs/${key.slice(i + 1)}`;
        const [url, thumbUrl] = await Promise.all([
          signedReadUrl(s3, bucket, key, 86400).catch(() => null),
          signedReadUrl(s3, bucket, thumbKey, 86400).catch(() => null),
        ]);
        return { name: key.slice(i + 1), url, thumbUrl };
      }),
    );

    return json({
      order: { id: order.id, title: order.title, paidAt: order.paid_at },
      photos,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
