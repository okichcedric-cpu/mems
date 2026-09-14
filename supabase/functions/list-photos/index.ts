import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
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
        status: 401, headers: corsHeaders,
      });
    }

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: corsHeaders,
      });
    }

    const { userId, collectionName, includeUrls, previewCount } = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const isOwner = userId === user.id;
    let hasAccess = isOwner;

    if (!isOwner) {
      const userEmail = user.email ?? '';
      const userEmailLower = userEmail.toLowerCase();
      // .in() binds each value as a parameter, unlike interpolating into .or().
      const { data: share } = await supabase
        .from('shared_collections')
        .select('id')
        .eq('owner_id', userId)
        .eq('collection_name', collectionName)
        .in('recipient_email', [userEmail, userEmailLower])
        .maybeSingle();
      hasAccess = !!share;
    }

    if (!hasAccess) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: corsHeaders,
      });
    }

    const s3 = new S3Client({
      region: Deno.env.get("AWS_REGION")!,
      credentials: {
        accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
        secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
      },
    });

    // Preview mode (see below) only ever returns Key + thumbUrl — captions
    // are never read off that shape, so skip this query entirely rather
    // than paying for it on every home-screen card for nothing.
    const isPreview =
      includeUrls && typeof previewCount === "number" && previewCount > 0;

    // Captions live in their own table (photo_captions), keyed by owner_id
    // + the photo's S3 key — read here with the service-role client
    // alongside the S3 listing (independent reads, so they run
    // concurrently) so a shared viewer sees captions too, the same way
    // they already see photos: this function has already verified access
    // above, RLS on photo_captions itself is owner-only and would reject
    // a viewer's own auth.uid().
    const [response, captionRows] = await Promise.all([
      s3.send(new ListObjectsV2Command({
        Bucket: Deno.env.get("S3_BUCKET")!,
        Prefix: `${userId}/${collectionName}/`,
      })),
      isPreview
        ? Promise.resolve([])
        : supabase
            .from('photo_captions')
            .select('photo_key, caption')
            .eq('owner_id', userId)
            .like('photo_key', `${userId}/${collectionName}/%`)
            .then(({ data }) => data ?? []),
    ]);

    const captionByKey = new Map(
      captionRows.map((row: any) => [row.photo_key, row.caption]),
    );

    const allObjects = response.Contents || [];
    const realPhotos = allObjects.filter(
      obj => obj.Key && !obj.Key.includes('/thumbs/')
    );

    // ── Lightweight preview mode ────────────────────────────────────
    // Used only by the home screen, which shows a 3-photo collage per
    // collection card — it never displays a photo's aspect ratio (the
    // collage tiles are fixed-size boxes with contentFit="cover") and
    // never shows the full-resolution image, only the thumbnail. The
    // full includeUrls path below used to run for the home screen too,
    // which meant every photo in every collection — not just the 3 ever
    // shown — paid for a HeadObjectCommand (a real S3 round trip, unlike
    // getSignedUrl below which is a local signing computation with no
    // network call) plus signing a full-res URL nobody was going to
    // load. For a collection with, say, 40 photos, that's 40 wasted S3
    // round trips on every home-screen load for a card that only ever
    // renders 3 thumbnails — far and away the biggest contributor to a
    // slow first load. previewCount slices the photo list down to just
    // what the collage needs BEFORE doing any of that per-photo work,
    // and skips HeadObject and full-url signing entirely, since neither
    // is ever read by the caller in this mode. totalCount still reflects
    // every real photo (from the single, already-cheap S3 LIST call
    // above), so the "N photos" badge on the card stays accurate even
    // though only a handful were actually signed.
    if (isPreview) {
      const previewTargets = realPhotos.slice(0, previewCount);
      const photos = await Promise.all(
        previewTargets.map(async (obj) => {
          const key = obj.Key!;
          const thumbKey = key.replace(
            `/${collectionName}/`,
            `/${collectionName}/thumbs/`,
          );
          const thumbUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({
              Bucket: Deno.env.get("S3_BUCKET")!,
              Key: thumbKey,
            }),
            { expiresIn: 86400 },
          ).catch(() => null);

          return { Key: key, thumbUrl };
        }),
      );

      return new Response(
        JSON.stringify({ photos, totalCount: realPhotos.length }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If includeUrls, generate all signed URLs and metadata in parallel
    if (includeUrls) {
      const photos = await Promise.all(
        realPhotos.map(async (obj) => {
          const key = obj.Key!;
          const thumbKey = key.replace(
            `/${collectionName}/`,
            `/${collectionName}/thumbs/`
          );

          // Get full URL and thumb URL in parallel
          const [url, thumbUrl, head] = await Promise.allSettled([
            getSignedUrl(s3, new GetObjectCommand({
              Bucket: Deno.env.get("S3_BUCKET")!,
              Key: key,
            }), { expiresIn: 604800 }),
            getSignedUrl(s3, new GetObjectCommand({
              Bucket: Deno.env.get("S3_BUCKET")!,
              Key: thumbKey,
            }), { expiresIn: 86400 }),
            s3.send(new HeadObjectCommand({
              Bucket: Deno.env.get("S3_BUCKET")!,
              Key: key,
            })),
          ]);

          const metadata = head.status === 'fulfilled'
            ? {
                width: parseInt(head.value.Metadata?.width ?? '1'),
                height: parseInt(head.value.Metadata?.height ?? '1'),
              }
            : { width: 1, height: 1 };

          return {
            Key: key,
            url: url.status === 'fulfilled' ? url.value : null,
            thumbUrl: thumbUrl.status === 'fulfilled' ? thumbUrl.value : null,
            metadata,
            caption: captionByKey.get(key) ?? null,
          };
        })
      );

      return new Response(
        JSON.stringify({ photos, totalCount: realPhotos.length }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Without URLs — just return keys (original behaviour)
    const photos = allObjects.map(obj => ({ Key: obj.Key }));
    return new Response(
      JSON.stringify({ photos }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: corsHeaders }
    );
  }
});