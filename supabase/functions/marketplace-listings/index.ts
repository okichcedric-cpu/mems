import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { S3Client } from "npm:@aws-sdk/client-s3";
import { createClient } from "npm:@supabase/supabase-js";
import { signedReadUrl } from "../_shared/cdn.ts";

// PUBLIC storefront data (no login needed). Actions:
//   list { sellerHandle?, limit? }  -> published listings, each with up to 3
//                                      cover thumbnails
//   get  { id }                     -> one published listing with ALL of its
//                                      public preview thumbnails
//
// Only the seller's chosen preview photos are ever signed, and only their
// thumbnails (never the full-resolution originals). Full photos are
// delivered only after purchase, by a separate authorised path.

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
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

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

    const thumbKeyOf = (key: string) => {
      const i = key.lastIndexOf("/");
      return `${key.slice(0, i)}/thumbs/${key.slice(i + 1)}`;
    };
    const signThumbs = (keys: string[]) =>
      Promise.all(
        keys.map((k) =>
          signedReadUrl(s3, bucket, thumbKeyOf(k), 86400).catch(() => null)
        ),
      );

    const cols =
      "id, seller_id, title, description, price_amount, currency, preview_count, photo_count, created_at, preview_keys";

    // Service role bypasses RLS, so re-apply "published + active creator".
    async function activeCreators(ids: string[]) {
      if (ids.length === 0) return new Map<string, any>();
      const { data } = await supabase
        .from("creator_profiles")
        .select("user_id, handle, display_name")
        .in("user_id", ids)
        .eq("status", "active");
      return new Map((data ?? []).map((c: any) => [c.user_id, c]));
    }

    const shape = (l: any, c: any, previews: (string | null)[]) => ({
      id: l.id,
      title: l.title,
      description: l.description,
      priceAmount: l.price_amount,
      currency: l.currency,
      previewCount: l.preview_count,
      photoCount: l.photo_count,
      createdAt: l.created_at,
      seller: { handle: c.handle, displayName: c.display_name },
      previews,
    });

    if (action === "get") {
      const id = String(body.id ?? "");
      if (!UUID.test(id)) return json({ listing: null });
      const { data: l } = await supabase
        .from("listings")
        .select(cols)
        .eq("id", id)
        .eq("status", "published")
        .maybeSingle();
      if (!l) return json({ listing: null });
      const creators = await activeCreators([l.seller_id]);
      const c = creators.get(l.seller_id);
      if (!c) return json({ listing: null });
      return json({ listing: shape(l, c, await signThumbs(l.preview_keys ?? [])) });
    }

    // Cover thumbnail as a data URL, so the browser can draw share cards on a
    // canvas without needing CORS on the CDN (works on localhost too).
    if (action === "card-image") {
      const id = String(body.id ?? "");
      if (!UUID.test(id)) return json({ image: null });
      const { data: l } = await supabase
        .from("listings")
        .select("seller_id, preview_keys")
        .eq("id", id)
        .eq("status", "published")
        .maybeSingle();
      const key = l?.preview_keys?.[0];
      if (!l || !key) return json({ image: null });
      const creators = await activeCreators([l.seller_id]);
      if (!creators.get(l.seller_id)) return json({ image: null });
      const [url] = await signThumbs([key]);
      if (!url) return json({ image: null });
      const img = await fetch(url);
      if (!img.ok) return json({ image: null });
      const bytes = new Uint8Array(await img.arrayBuffer());
      if (bytes.length > 3_000_000) return json({ image: null });
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const type = img.headers.get("content-type") || "image/jpeg";
      return json({ image: `data:${type};base64,${btoa(bin)}` });
    }

    if (action === "list") {
      const limit = Math.min(Math.max(parseInt(body.limit ?? 24, 10) || 24, 1), 48);
      let sellerId: string | null = null;
      if (typeof body.sellerHandle === "string" && body.sellerHandle) {
        const { data: s } = await supabase
          .from("creator_profiles")
          .select("user_id")
          .eq("handle", body.sellerHandle.trim().toLowerCase())
          .eq("status", "active")
          .maybeSingle();
        if (!s) return json({ listings: [] });
        sellerId = s.user_id;
      }

      let q = supabase
        .from("listings")
        .select(cols)
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .limit(sellerId ? limit : 300);
      if (sellerId) q = q.eq("seller_id", sellerId);
      const { data: rows } = await q;
      let listings = rows ?? [];

      // Landing-page feed: mix sellers instead of letting one prolific
      // seller fill the page. Take each seller's newest listing first, then
      // their next, and so on (round-robin), keeping newest-first within a
      // round.
      if (!sellerId) {
        const bySeller = new Map<string, any[]>();
        for (const l of listings) {
          if (!bySeller.has(l.seller_id)) bySeller.set(l.seller_id, []);
          bySeller.get(l.seller_id)!.push(l);
        }
        const mixed: any[] = [];
        for (let round = 0; mixed.length < listings.length; round++) {
          const batch = [...bySeller.values()]
            .map((arr) => arr[round])
            .filter(Boolean)
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
          if (batch.length === 0) break;
          mixed.push(...batch);
        }
        listings = mixed.slice(0, limit);
      }

      const creators = await activeCreators([...new Set(listings.map((l: any) => l.seller_id))]);
      const out = await Promise.all(
        listings
          .filter((l: any) => creators.has(l.seller_id))
          .map(async (l: any) =>
            shape(l, creators.get(l.seller_id), await signThumbs((l.preview_keys ?? []).slice(0, 3)))
          ),
      );
      return json({ listings: out });
    }

    return json({ error: "Invalid request." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
