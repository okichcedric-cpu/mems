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

// ── Bounded-concurrency map ──────────────────────────────────────────
// Copying objects one at a time — awaiting each CopyObjectCommand before
// starting the next — was the actual source of the slowness: a 75-photo
// collection has ~150 objects (photos + thumbs), and at, say, 150-250ms
// per round trip to S3, that's 20-35+ seconds run serially. Running a
// bounded number of copies concurrently instead cuts that down to
// roughly (object count / limit) round trips, without firing hundreds of
// requests at once (a fixed pool is friendlier to S3 and to the edge
// function's own connection limits than unbounded Promise.all).
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
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

    // ── Reject if a DIFFERENT existing collection already has this name,
    // and gather every object under the old prefix (paginated) — these
    // are independent reads, so they run concurrently instead of one
    // after the other.
    const [collisionCheck, objects] = await Promise.all([
      s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: newPrefix,
          MaxKeys: 1,
        }),
      ),
      (async () => {
        const keys: string[] = [];
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
            if (o.Key) keys.push(o.Key);
          }
          continuationToken = listResult.NextContinuationToken;
        } while (continuationToken);
        return keys;
      })(),
    ]);

    if ((collisionCheck.Contents ?? []).length > 0) {
      return new Response(
        JSON.stringify({
          error: "A collection with this name already exists.",
        }),
        { status: 409, headers: corsHeaders },
      );
    }

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
    // operation, so copy-then-delete is the standard approach. Copies run
    // with bounded concurrency (see mapWithConcurrency above) rather than
    // one at a time, which is what made this slow in the first place.
    const copiedKeys: string[] = [];
    try {
      await mapWithConcurrency(objects, 20, async (key) => {
        const newKey = newPrefix + key.slice(oldPrefix.length);
        await s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: encodeURIComponent(`${bucket}/${key}`),
            Key: newKey,
          }),
        );
        copiedKeys.push(key);
      });
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

    // ── Keep any active shares — and any memory-date metadata row —
    // pointed at the new name ─────────────────────────────────────
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

    // shared_photos rows are keyed by the photo's FULL S3 key too (same
    // situation as photo_captions below), so a rename needs both its
    // display-only collection_name column AND its photo_key prefix
    // rewritten — the collection_name update alone would leave the
    // recipient's home screen card showing the OLD album name forever,
    // and the photo_key would point at bytes that no longer exist there.
    const { data: photoShareRows, error: photoShareSelectError } =
      await supabase
        .from("shared_photos")
        .select("id, photo_key")
        .eq("owner_id", userId)
        .like("photo_key", `${oldPrefix}%`);

    if (photoShareSelectError) {
      console.error(
        "rename-collection: failed to read shared_photos:",
        photoShareSelectError.message,
      );
    } else if (photoShareRows && photoShareRows.length > 0) {
      await mapWithConcurrency(photoShareRows, 20, async (row) => {
        const newKey = newPrefix + row.photo_key.slice(oldPrefix.length);
        const { error } = await supabase
          .from("shared_photos")
          .update({ photo_key: newKey, collection_name: trimmedNew })
          .eq("id", row.id);
        if (error) {
          console.error(
            "rename-collection: failed to re-key a shared_photos row:",
            error.message,
          );
        }
      });
    }

    // The collections table is optional metadata (a collection may not
    // have a row at all if no memory date has ever been set on it), so
    // this update is a no-op — not an error — when there's nothing to
    // rename.
    const { error: metadataUpdateError } = await supabase
      .from("collections")
      .update({ name: trimmedNew })
      .eq("owner_id", userId)
      .eq("name", trimmedOld);

    if (metadataUpdateError) {
      console.error(
        "rename-collection: failed to update collections metadata:",
        metadataUpdateError.message,
      );
    }

    // photo_captions rows are keyed by the photo's FULL S3 key, which just
    // changed for every object above (the collection-name segment of the
    // path). A plain column UPDATE can't do a substring replace here
    // without raw SQL, so this reads back the (usually small) set of
    // caption rows under the old prefix and rewrites each photo_key
    // individually — best-effort, same as the two updates above: a
    // failure here leaves an orphaned caption row pointing at a key that
    // no longer exists, not a broken rename.
    const { data: captionRows, error: captionSelectError } = await supabase
      .from("photo_captions")
      .select("photo_key")
      .eq("owner_id", userId)
      .like("photo_key", `${oldPrefix}%`);

    if (captionSelectError) {
      console.error(
        "rename-collection: failed to read photo_captions:",
        captionSelectError.message,
      );
    } else if (captionRows && captionRows.length > 0) {
      await mapWithConcurrency(captionRows, 20, async (row) => {
        const newKey = newPrefix + row.photo_key.slice(oldPrefix.length);
        const { error } = await supabase
          .from("photo_captions")
          .update({ photo_key: newKey })
          .eq("owner_id", userId)
          .eq("photo_key", row.photo_key);
        if (error) {
          console.error(
            "rename-collection: failed to re-key a photo_captions row:",
            error.message,
          );
        }
      });
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
