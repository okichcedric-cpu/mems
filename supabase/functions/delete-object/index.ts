import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { DeleteObjectCommand, S3Client } from "npm:@aws-sdk/client-s3";
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
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: corsHeaders }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: corsHeaders }
      );
    }

    const { key } = await req.json();

    // Security — user can only delete from their own folder
    if (!key.startsWith(`${user.id}/`)) {
      return new Response(
        JSON.stringify({ error: "Forbidden" }),
        { status: 403, headers: corsHeaders }
      );
    }

    const s3 = new S3Client({
      region: Deno.env.get("AWS_REGION")!,
      credentials: {
        accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
        secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
      },
    });

    // Delete full image
    await s3.send(new DeleteObjectCommand({
      Bucket: Deno.env.get("S3_BUCKET")!,
      Key: key,
    }));

    // Delete thumbnail if it exists
    if (!key.includes("/thumbs/")) {
      const parts = key.split("/");
      const fileName = parts.pop()!;
      const thumbKey = [...parts, "thumbs", fileName].join("/");
      try {
        await s3.send(new DeleteObjectCommand({
          Bucket: Deno.env.get("S3_BUCKET")!,
          Key: thumbKey,
        }));
      } catch {
        // Thumbnail may not exist — ignore
      }
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("delete-object error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});