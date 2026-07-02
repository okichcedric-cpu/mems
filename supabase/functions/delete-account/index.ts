import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "npm:@aws-sdk/client-s3";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Auth check — user can only delete their own account ──
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

    const { data: { user }, error: authError } =
      await supabaseAuth.auth.getUser(authHeader.replace("Bearer ", ""));

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: corsHeaders,
      });
    }

    const userId = user.id;
    const userEmail = user.email;

    console.log(`Account deletion started for user ${userId} (${userEmail})`);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Step 1 — Delete all S3 objects under this user's prefix ──
    const s3Client = new S3Client({
      region: Deno.env.get("AWS_REGION")!,
      credentials: {
        accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
        secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
      },
    });

    const bucket = Deno.env.get("S3_BUCKET")!;
    let deletedObjectCount = 0;

    try {
      let continuationToken: string | undefined;
      do {
        const listResult = await s3Client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${userId}/`,
            ContinuationToken: continuationToken,
          }),
        );

        const objects = listResult.Contents ?? [];
        if (objects.length > 0) {
          await s3Client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: {
                Objects: objects.map((o) => ({ Key: o.Key! })),
              },
            }),
          );
          deletedObjectCount += objects.length;
        }

        continuationToken = listResult.NextContinuationToken;
      } while (continuationToken);

      console.log(`Deleted ${deletedObjectCount} S3 objects for user ${userId}`);
    } catch (s3Error: any) {
      // Log but don't block account deletion if S3 cleanup partially fails
      console.error(`S3 cleanup error for user ${userId}:`, s3Error.message);
    }

    // ── Step 2 — Remove collections this user shared with others ──
    const { error: sharedOutError } = await supabase
      .from("shared_collections")
      .delete()
      .eq("owner_id", userId);

    if (sharedOutError) {
      console.error("Error removing owned shares:", sharedOutError.message);
    }

    // ── Step 3 — Remove collections shared TO this user by others ──
    const { error: sharedInError } = await supabase
      .from("shared_collections")
      .delete()
      .or(`recipient_id.eq.${userId}${userEmail ? `,recipient_email.eq.${userEmail}` : ""}`);

    if (sharedInError) {
      console.error("Error removing received shares:", sharedInError.message);
    }

    // ── Step 4 — Delete subscription record ──
    const { error: subError } = await supabase
      .from("subscriptions")
      .delete()
      .eq("user_id", userId);

    if (subError) {
      console.error("Error deleting subscription record:", subError.message);
    }

    // ── Step 5 — Delete the auth user account itself ──
    // This is the final, irreversible step
    const { error: deleteUserError } = await supabase.auth.admin.deleteUser(userId);

    if (deleteUserError) {
      console.error(`Failed to delete auth user ${userId}:`, deleteUserError.message);
      return new Response(
        JSON.stringify({ error: "Something went wrong. Please try again." }),
        { status: 500, headers: corsHeaders },
      );
    }

    console.log(`Account fully deleted for user ${userId} (${userEmail})`);

    return new Response(
      JSON.stringify({ success: true }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: any) {
    console.error("delete-account error:", error.message, error.stack);
    return new Response(
      JSON.stringify({ error: "Something went wrong. Please try again." }),
      { status: 500, headers: corsHeaders },
    );
  }
});