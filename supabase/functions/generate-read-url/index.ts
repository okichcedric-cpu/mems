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

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", "")
    );

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const { key } = await req.json();

    if (!key) {
      return new Response(JSON.stringify({ error: "Missing key" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Extract owner ID and collection name from key: userId/collectionName/fileName
    const keyParts = key.split("/");
    const ownerId = keyParts[0];
    const collectionName = keyParts[1];

    // Use service role to query shared_collections without RLS interference
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Check access — owner OR recipient of a shared collection
    const isOwner = ownerId === user.id;
    let hasAccess = isOwner;

    if (!isOwner) {
      const userEmail = user.email ?? '';
      const userEmailLower = userEmail.toLowerCase();

      const { data: share } = await supabase
        .from('shared_collections')
        .select('id')
        .eq('owner_id', ownerId)
        .eq('collection_name', collectionName)
        .or(`recipient_email.eq.${userEmail},recipient_email.eq.${userEmailLower}`)
        .maybeSingle();

      hasAccess = !!share;
    }

    if (!hasAccess) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    const s3 = new S3Client({
      region: Deno.env.get("AWS_REGION")!,
      credentials: {
        accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
        secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
      },
    });

    // Get image metadata (width/height)
    let metadata = { width: 1, height: 1 };
    try {
      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: Deno.env.get("S3_BUCKET")!,
          Key: key,
        })
      );
      metadata = {
        width: parseInt(head.Metadata?.width ?? "1"),
        height: parseInt(head.Metadata?.height ?? "1"),
      };
    } catch {
      // Metadata not available — use defaults
    }

    // Generate signed URL valid for 24 hours
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: Deno.env.get("S3_BUCKET")!,
        Key: key,
      }),
      { expiresIn: 86400 }
    );

    return new Response(
      JSON.stringify({ url, metadata }),
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