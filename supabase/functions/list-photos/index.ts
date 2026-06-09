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

    const { userId, collectionName, includeUrls } = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const isOwner = userId === user.id;
    let hasAccess = isOwner;

    if (!isOwner) {
      const userEmail = user.email ?? '';
      const { data: share } = await supabase
        .from('shared_collections')
        .select('id')
        .eq('owner_id', userId)
        .eq('collection_name', collectionName)
        .or(`recipient_email.eq.${userEmail},recipient_email.eq.${userEmail.toLowerCase()}`)
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

    const response = await s3.send(new ListObjectsV2Command({
      Bucket: Deno.env.get("S3_BUCKET")!,
      Prefix: `${userId}/${collectionName}/`,
    }));

    const allObjects = response.Contents || [];
    const realPhotos = allObjects.filter(
      obj => obj.Key && !obj.Key.includes('/thumbs/')
    );

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
            }), { expiresIn: 86400 }),
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
          };
        })
      );

      return new Response(
        JSON.stringify({ photos }),
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