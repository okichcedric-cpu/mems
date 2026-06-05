import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { ListObjectsV2Command, S3Client } from "npm:@aws-sdk/client-s3";
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

    const { userId, collectionName } = await req.json();

    // Use service role to query shared_collections without RLS interference
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Check access — owner OR recipient of a shared collection
    const isOwner = userId === user.id;
    let hasAccess = isOwner;

    if (!isOwner) {
      const userEmail = user.email ?? '';
      const userEmailLower = userEmail.toLowerCase();

      const { data: share } = await supabase
        .from('shared_collections')
        .select('id')
        .eq('owner_id', userId)
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

    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: Deno.env.get("S3_BUCKET")!,
        Prefix: `${userId}/${collectionName}/`,
      })
    );

    const photos = (response.Contents || []).map((obj) => ({ Key: obj.Key }));

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