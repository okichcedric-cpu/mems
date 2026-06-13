import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PutObjectCommand, S3Client } from "npm:@aws-sdk/client-s3";
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

    // Verify user JWT
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

    const { key, contentType, width, height } = await req.json();

    if (!key) {
      return new Response(JSON.stringify({ error: "Missing key" }), {
        status: 400, headers: corsHeaders,
      });
    }

    // Reject non-image content types
const allowedTypes = [
  "image/jpeg", "image/jpg", "image/png", "image/webp",
  "image/heic", "image/heif", "image/gif", "image/bmp",
];

if (contentType && !allowedTypes.some(t => contentType.startsWith("image/"))) {
  return new Response(
    JSON.stringify({ error: "Only image files are allowed" }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

    // Extract owner ID and collection name from key
    const keyParts = key.split("/");
    const ownerId = keyParts[0];
    const collectionName = keyParts[1];

    // Use service role to check share records without RLS interference
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Allow if owner OR if collection is shared with this user
    const isOwner = ownerId === user.id;
    let hasAccess = isOwner;

    if (!isOwner) {
      const userEmail = user.email ?? "";
      const userEmailLower = userEmail.toLowerCase();

      const { data: share } = await supabase
        .from("shared_collections")
        .select("id")
        .eq("owner_id", ownerId)
        .eq("collection_name", collectionName)
        .or(`recipient_email.eq.${userEmail},recipient_email.eq.${userEmailLower}`)
        .maybeSingle();

      hasAccess = !!share;
      console.log("Share check for upload:", userEmail, "on", collectionName, "->", hasAccess);
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

    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: Deno.env.get("S3_BUCKET")!,
        Key: key,
        ContentType: contentType ?? "image/jpeg",
        Metadata: {
          width: String(width ?? 1),
          height: String(height ?? 1),
        },
      }),
      { expiresIn: 300 }
    );

    return new Response(
      JSON.stringify({ url }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("generate-upload-url error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: corsHeaders,
    });
  }
});