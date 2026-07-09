import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "npm:@aws-sdk/client-s3";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Collection names double as literal S3 key segments
// (`${userId}/${collectionName}/...`), so anything that could break out
// of that path segment is rejected outright rather than silently
// sanitized — better to ask for a different name than to guess intent.
function isValidCollectionName(name: string): boolean {
  if (!name || name.length > 80) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name === "." || name === "..") return false;
  if (/[\x00-\x1f]/.test(name)) return false;
  return true;
}

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

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );

    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser(authHeader.replace("Bearer ", ""));

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const { oldName, newName } = await req.json();

    if (typeof oldName !== "string" || typeof newName !== "string") {
      return new Response(JSON.stringify({ error: "Invalid request" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const trimmedOld = oldName.trim();
    const trimmedNew = newName.trim();

    if (!isValidCollectionName(trimmedNew)) {
      return new Response(
        JSON.stringify({
          error:
            'Collection names can\'t be empty, contain "/", or exceed 80 characters.',
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    const userId = user.id;
    const bucket = Deno.env.get("S3_BUCKET")!;
    const s3 = new S3Client({
      region: Deno.env.get("AWS_REGION")!,
      credentials: {
        accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
        secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
      },
    });

    // No-op rename (e.g. only whitespace trimmed) — nothing to move.
    if (trimmedOld === trimmedNew) {
      return new Response(
        JSON.stringify({ success: true, newName: trimmedNew }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const oldPrefix = `${userId}/${trimmedOld}/`;
    const newPrefix = `${userId}/${trimmedNew}/`;

    // ── Reject if a DIFFERENT existing collection already has this name ──
    const collisionCheck = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: newPrefix,
        MaxKeys: 1,
      }),
    );
    if ((collisionCheck.Contents ?? []).length > 0) {
      return new Response(
        JSON.stringify({
          error: "A collection with this name already exists.",
        }),
        { status: 409, headers: corsHeaders },
      );
    }

    // ── Gather every object under the old prefix (paginated) ──
    const objects: string[] = [];
    let continuationToken: string | undefined;
    do {
      const listResult = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: oldPrefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const o of listResult.Contents ?? []) {
        if (o.Key) objects.push(o.Key);
      }
      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

    if (objects.length === 0) {
      return new Response(JSON.stringify({ error: "Collection not found." }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    // ── Copy everything to the new prefix first ───────────────────
    // Only once every copy has succeeded do we touch the originals — if
    // a copy fails partway through, the old collection is left completely
    // intact instead of half-renamed. S3 has no atomic "rename a folder"
    // operation, so copy-then-delete is the standard approach.
    const copiedKeys: string[] = [];
    try {
      for (const key of objects) {
        const newKey = newPrefix + key.slice(oldPrefix.length);
        await s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: encodeURIComponent(`${bucket}/${key}`),
            Key: newKey,
          }),
        );
        copiedKeys.push(key);
      }
    } catch (copyError: any) {
      console.error("rename-collection copy failed:", copyError.message);
      return new Response(
        JSON.stringify({
          error: "Could not rename collection. Please try again.",
        }),
        { status: 500, headers: corsHeaders },
      );
    }

    // ── Delete the old objects now that copies are confirmed ──────
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: copiedKeys.map((Key) => ({ Key })) },
      }),
    );

    // ── Keep any active shares pointed at the new name ────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { error: shareUpdateError } = await supabase
      .from("shared_collections")
      .update({ collection_name: trimmedNew })
      .eq("owner_id", userId)
      .eq("collection_name", trimmedOld);

    if (shareUpdateError) {
      console.error(
        "rename-collection: failed to update shared_collections:",
        shareUpdateError.message,
      );
    }

    return new Response(
      JSON.stringify({ success: true, newName: trimmedNew }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: any) {
    console.error("rename-collection error:", error.message);
    return new Response(
      JSON.stringify({ error: "Something went wrong. Please try again." }),
      { status: 500, headers: corsHeaders },
    );
  }
});
