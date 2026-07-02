import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner";
import { createClient } from "npm:@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── Allowed image MIME types ──────────────────────────────
// Note: iPhone shoots HEIC but s3.ts compresses everything to JPEG
// before upload — so in practice only image/jpeg arrives here.
// The full set is kept for completeness and future native paths.
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  // Some iOS versions report these variants
  "image/heic-sequence",
  "image/heif-sequence",
]);

// Max 15MB per image
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;

// ── Path traversal sanitiser ──────────────────────────────
// Allows alphanumeric, spaces, dots, dashes, underscores,
// parentheses and forward slashes — covers most collection names
// Blocks path traversal sequences only
function sanitisePath(key: string): string {
  return key
    .replace(/\.{2,}/g, ".")     // collapse .. to prevent traversal
    .replace(/^\/+/, "")          // strip leading slashes
    .replace(/\/+/g, "/")         // collapse double slashes
    .replace(/[<>:"\\|?*\x00-\x1f]/g, ""); // strip truly dangerous chars only
}

// Validate the sanitised path is safe — separate from sanitising
function isPathSafe(original: string, sanitised: string): boolean {
  // Reject if sanitising changed the path — means it had dangerous chars
  return original === sanitised;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Auth check ────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: corsHeaders },
      );
    }

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );

    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: corsHeaders },
      );
    }

    // ── Parse request body ────────────────────────────────
    const { key, contentType, fileSize, width, height } = await req.json();

    // ── Validation 1 — key must be present ────────────────
    if (!key || typeof key !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid file key" }),
        { status: 400, headers: corsHeaders },
      );
    }

    // ── Validation 2 — MIME type whitelist ───────────────
    // Normalise content type — strip parameters e.g. "image/jpeg; charset=utf-8"
    const normalisedType = (contentType ?? "").toLowerCase().split(";")[0].trim();

    if (!normalisedType || !ALLOWED_MIME_TYPES.has(normalisedType)) {
      console.warn(
        `Rejected upload — disallowed content type: "${contentType}" normalised to "${normalisedType}" from user ${user.id}`,
      );
      return new Response(
        JSON.stringify({
          error: `File type not allowed: ${contentType ?? "unknown"}. Only JPEG, PNG, WebP, GIF and HEIC images are accepted.`,
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    // ── Validation 3 — SVG explicit block ────────────────
    if (normalisedType.includes("svg")) {
      return new Response(
        JSON.stringify({ error: "SVG files are not allowed for security reasons." }),
        { status: 400, headers: corsHeaders },
      );
    }

    // ── Validation 4 — File size ──────────────────────────
    if (fileSize !== undefined && fileSize !== null) {
      if (typeof fileSize !== "number" || fileSize <= 0) {
        return new Response(
          JSON.stringify({ error: "Invalid file size" }),
          { status: 400, headers: corsHeaders },
        );
      }
      if (fileSize > MAX_FILE_SIZE_BYTES) {
        const maxMB = MAX_FILE_SIZE_BYTES / (1024 * 1024);
        return new Response(
          JSON.stringify({
            error: `File too large. Maximum size is ${maxMB}MB per image.`,
          }),
          { status: 400, headers: corsHeaders },
        );
      }
    }

    // ── Validation 5 — Path traversal prevention ──────────
    const safeKey = sanitisePath(key);
    if (!safeKey || !isPathSafe(key, safeKey)) {
      console.warn(
        `Rejected — unsafe path: original="${key}" sanitised="${safeKey}" user=${user.id}`,
      );
      return new Response(
        JSON.stringify({ error: "Invalid file path" }),
        { status: 400, headers: corsHeaders },
      );
    }

    // Log the incoming request for debugging
    console.log(
      `Upload request — user=${user.id} key="${key}" type=${normalisedType} size=${fileSize ?? "unknown"}`,
    );

    // ── Validation 6 — Authorised path check ──────────────
    // Expected key format: {ownerId}/{collectionName}/{filename}
    // Thumb format:        {ownerId}/{collectionName}/thumbs/{filename}
    const keyParts = safeKey.split("/");
    if (keyParts.length < 3) {
      return new Response(
        JSON.stringify({ error: "Invalid file path structure" }),
        { status: 400, headers: corsHeaders },
      );
    }

    const keyOwnerId = keyParts[0];
    // keyParts[1] is always the collection name in both formats:
    // {ownerId}/{collectionName}/{filename}
    // {ownerId}/{collectionName}/thumbs/{filename}
    const collectionName = keyParts[1];

    const isOwner = keyOwnerId === user.id;

    if (!isOwner) {
      // Not the owner — check if they have been granted share access
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      // Check by recipient_id first (faster), then fall back to email match
      const { data: shareByUserId } = await supabase
        .from("shared_collections")
        .select("id")
        .eq("owner_id", keyOwnerId)
        .eq("collection_name", collectionName)
        .eq("recipient_id", user.id)
        .maybeSingle();

      // If not found by user ID, try by email
      let shareRecord = shareByUserId;
      if (!shareRecord && user.email) {
        const { data: shareByEmail } = await supabase
          .from("shared_collections")
          .select("id")
          .eq("owner_id", keyOwnerId)
          .eq("collection_name", collectionName)
          .eq("recipient_email", user.email)
          .maybeSingle();
        shareRecord = shareByEmail;
      }

      if (!shareRecord) {
        console.warn(
          `Rejected — user ${user.id} (${user.email}) not authorised for ${keyOwnerId}/${collectionName}`,
        );
        return new Response(
          JSON.stringify({
            error: "You do not have permission to upload to this collection.",
          }),
          { status: 403, headers: corsHeaders },
        );
      }

      console.log(
        `Shared upload authorised — user ${user.id} → ${keyOwnerId}/${collectionName}`,
      );
    }

    // ── Generate presigned S3 URL ─────────────────────────
    const s3Client = new S3Client({
      region: Deno.env.get("AWS_REGION")!,
      credentials: {
        accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
        secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
      },
    });

    // Always use image/jpeg for the S3 content type —
    // s3.ts compresses everything to JPEG before upload
    // so the stored file is always JPEG regardless of source format
    const s3ContentType = normalisedType.includes("jpeg") ||
      normalisedType.includes("jpg") ||
      normalisedType.includes("heic") ||
      normalisedType.includes("heif")
      ? "image/jpeg"
      : normalisedType;

    const command = new PutObjectCommand({
      Bucket: Deno.env.get("S3_BUCKET")!,
      Key: safeKey,
      ContentType: s3ContentType,
      ...(width && height
        ? { Metadata: { width: String(width), height: String(height) } }
        : {}),
    });

    // 5 minute expiry — short window reduces risk of leaked URLs
    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 300,
    });

    console.log(
      `Upload URL generated — user: ${user.id} owner: ${keyOwnerId} key: ${safeKey} type: ${s3ContentType} size: ${fileSize ?? "unknown"}`,
    );

    return new Response(
      JSON.stringify({ uploadUrl, key: safeKey }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: any) {
    console.error("generate-upload-url error:", error.message);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});