import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { ListObjectsV2Command, S3Client } from "npm:@aws-sdk/client-s3";
import { createClient } from "npm:@supabase/supabase-js";

// Seller-side listing management. Actions:
//   publish   { collectionName, title, description, priceAmount, previewCount }
//             creates or updates the listing for this collection
//   unpublish { collectionName }
//   get       { collectionName }  -> the caller's listing for that collection
//
// All writes go through here (service role) so that ownership of the S3
// collection, the active creator profile, and the preview snapshot are all
// verified server-side. Clients cannot write the listings table directly.

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

const COLUMNS =
  "id, collection_name, title, description, price_amount, currency, preview_count, photo_count, status";

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

    const body = await req.json();
    const action = body?.action;
    const collectionName = typeof body?.collectionName === "string" ? body.collectionName.trim() : "";
    if (
      !collectionName || collectionName.length > 80 ||
      collectionName.includes("/") || collectionName.includes("\\") ||
      /[\x00-\x1f]/.test(collectionName) || collectionName === "." || collectionName === ".."
    ) {
      return json({ error: "Invalid collection." }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (action === "get") {
      const { data } = await supabase
        .from("listings")
        .select(COLUMNS)
        .eq("seller_id", user.id)
        .eq("collection_name", collectionName)
        .maybeSingle();
      return json({ listing: data ?? null });
    }

    if (action === "unpublish") {
      const { data, error } = await supabase
        .from("listings")
        .update({ status: "unpublished" })
        .eq("seller_id", user.id)
        .eq("collection_name", collectionName)
        .neq("status", "removed")
        .select(COLUMNS)
        .maybeSingle();
      if (error) return json({ error: "Could not unpublish." }, 500);
      return json({ listing: data ?? null });
    }

    if (action !== "publish") return json({ error: "Invalid request." }, 400);

    // ── publish ──────────────────────────────────────────────────────────
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const priceAmount = body.priceAmount;
    const previewCount = body.previewCount;

    if (title.length < 3 || title.length > 80) {
      return json({ error: "Title must be 3-80 characters." }, 400);
    }
    if (description.length > 600) {
      return json({ error: "Description must be 600 characters or fewer." }, 400);
    }
    if (!Number.isInteger(priceAmount) || priceAmount < 50 || priceAmount > 500000) {
      return json({ error: "Price must be between KES 50 and KES 500,000." }, 400);
    }
    if (!Number.isInteger(previewCount) || previewCount < 1 || previewCount > 20) {
      return json({ error: "Choose between 1 and 20 public preview photos." }, 400);
    }

    // Must have an active marketplace account.
    const { data: creator } = await supabase
      .from("creator_profiles")
      .select("user_id, status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!creator || creator.status !== "active") {
      return json({ error: "Set up your marketplace account first." }, 403);
    }

    // The collection must exist under the caller's own prefix.
    const s3 = new S3Client({
      region: Deno.env.get("AWS_REGION")!,
      credentials: {
        accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
        secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
      },
    });
    const prefix = `${user.id}/${collectionName}/`;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await s3.send(new ListObjectsV2Command({
        Bucket: Deno.env.get("S3_BUCKET")!,
        Prefix: prefix,
        ContinuationToken: token,
      }));
      for (const o of res.Contents ?? []) {
        if (o.Key && !o.Key.includes("/thumbs/") && !o.Key.endsWith("/")) keys.push(o.Key);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    if (keys.length === 0) {
      return json({ error: "This collection has no photos to sell." }, 400);
    }
    if (previewCount > keys.length) {
      return json({ error: `This collection only has ${keys.length} photo(s).` }, 400);
    }
    keys.sort();

    // A listing taken down by Picture Board can't be republished by the seller.
    const { data: existingListing } = await supabase
      .from("listings")
      .select("status")
      .eq("seller_id", user.id)
      .eq("collection_name", collectionName)
      .maybeSingle();
    if (existingListing?.status === "removed") {
      return json({
        error: "This listing was removed by Picture Board. Contact contact@mems-app.com for details.",
      }, 403);
    }

    const { data, error } = await supabase
      .from("listings")
      .upsert(
        {
          seller_id: user.id,
          collection_name: collectionName,
          title,
          description,
          price_amount: priceAmount,
          currency: "KES",
          preview_count: previewCount,
          preview_keys: keys.slice(0, previewCount),
          photo_count: keys.length,
          status: "published",
        },
        { onConflict: "seller_id,collection_name" },
      )
      .select(COLUMNS)
      .single();
    if (error) return json({ error: "Could not publish this listing." }, 500);
    return json({ listing: data });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
