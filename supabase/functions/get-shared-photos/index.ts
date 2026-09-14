import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    // Use anon key to verify the user's JWT
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(authHeader.replace("Bearer ", ""));

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const userEmail = user.email ?? '';
    const userEmailLower = userEmail.toLowerCase();

    // Use service role to bypass RLS entirely — mirrors get-shared-collections.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Two parameterized queries run in parallel — same reasoning as
    // get-shared-collections: .in()/.eq() bind values directly rather than
    // interpolating into a filter string.
    const [byEmailResult, byUserIdResult] = await Promise.all([
      supabase
        .from('shared_photos')
        .select('owner_id, owner_email, collection_name, photo_key, recipient_email')
        .in('recipient_email', [userEmail, userEmailLower]),
      supabase
        .from('shared_photos')
        .select('owner_id, owner_email, collection_name, photo_key, recipient_email')
        .eq('recipient_id', user.id),
    ]);

    if (byEmailResult.error) throw new Error(byEmailResult.error.message);
    if (byUserIdResult.error) throw new Error(byUserIdResult.error.message);

    const rows = [...(byEmailResult.data ?? []), ...(byUserIdResult.data ?? [])];

    // Deduplicate by owner_id + photo_key in case email variants matched twice.
    const seen = new Set<string>();
    const uniqueRows = rows.filter((r: any) => {
      const key = `${r.owner_id}-${r.photo_key}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Update recipient_id for future lookups if not already set — same
    // backfill pattern as get-shared-collections.
    if (uniqueRows.length > 0) {
      await supabase
        .from('shared_photos')
        .update({ recipient_id: user.id })
        .in('recipient_email', [userEmail, userEmailLower])
        .is('recipient_id', null);
    }

    const s3 = new S3Client({
      region: Deno.env.get("AWS_REGION")!,
      credentials: {
        accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
        secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
      },
    });
    const bucket = Deno.env.get("S3_BUCKET")!;

    // Captions live in their own table (photo_captions), keyed by owner_id
    // + the photo's S3 key — same table list-photos already joins for a
    // full-collection view. A recipient's shared-photos strip should show
    // the CURRENT caption too (not a copy frozen at share time), so this
    // reads photo_captions fresh on every fetch, exactly like list-photos
    // does. photo_key is already globally unique (it embeds owner_id and
    // collection_name as its own prefix), so a plain .in() on the exact
    // keys is sufficient scoping — no separate owner_id filter needed
    // since these rows can span multiple owners.
    const shareKeys = uniqueRows.map((r: any) => r.photo_key as string);
    const captionByKey = new Map<string, string>();
    if (shareKeys.length > 0) {
      const { data: captionRows, error: captionError } = await supabase
        .from('photo_captions')
        .select('photo_key, caption')
        .in('photo_key', shareKeys);
      if (captionError) {
        console.warn('get-shared-photos caption lookup error:', captionError.message);
      } else {
        for (const row of captionRows ?? []) {
          captionByKey.set(row.photo_key, row.caption);
        }
      }
    }

    // A row whose photo has since been deleted (owner deleted the photo
    // or the whole collection, without necessarily deleting this share
    // row first) shouldn't surface as a broken card — HeadObject fails
    // for a missing key, and that's the signal to just drop it here
    // rather than return a photo the app can't actually display.
    const photos = (
      await Promise.all(
        uniqueRows.map(async (row: any) => {
          const key = row.photo_key as string;
          const thumbKey = key.replace(
            `/${row.collection_name}/`,
            `/${row.collection_name}/thumbs/`,
          );

          const [url, thumbUrl, head] = await Promise.allSettled([
            getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: bucket, Key: key }),
              { expiresIn: 604800 },
            ),
            getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: bucket, Key: thumbKey }),
              { expiresIn: 86400 },
            ),
            s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
          ]);

          if (head.status !== "fulfilled") return null;

          const metadata = {
            width: parseInt(head.value.Metadata?.width ?? "1"),
            height: parseInt(head.value.Metadata?.height ?? "1"),
          };

          return {
            ownerId: row.owner_id,
            ownerEmail: row.owner_email ?? "Unknown",
            collectionName: row.collection_name,
            photoKey: key,
            url: url.status === "fulfilled" ? url.value : null,
            thumbUrl: thumbUrl.status === "fulfilled" ? thumbUrl.value : null,
            metadata,
            caption: captionByKey.get(key) ?? null,
          };
        }),
      )
    ).filter((p): p is NonNullable<typeof p> => p !== null);

    return new Response(
      JSON.stringify({ photos }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
});
