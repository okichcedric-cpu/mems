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
// Covers standard types plus all known iOS HEIC variants:
// - Older iPhones (6S/7 era, iOS 13 and below) may report x-image/heic
// - Burst/Live photos use heic-sequence / heif-sequence
// - All HEIC variants are normalised to image/jpeg at the S3 layer
//   since s3.ts compresses everything to JPEG before upload
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  // Standard HEIC — iOS 14+
  "image/heic",
  "image/heif",
  // Burst/Live Photos
  "image/heic-sequence",
  "image/heif-sequence",
  // Older iOS Safari variants (iOS 13 and below)
  "x-image/heic",
  "x-image/heif",
]);

// Max 15MB per image
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;

// ── Returns true if the MIME type is any known HEIC/HEIF variant ─
// Handles all older iOS reporting quirks including x-image/* prefix
function isHeicVariant(mimeType: string): boolean {
  return (
    mimeType.includes("heic") ||
    mimeType.includes("heif") ||
    mimeType.startsWith("x-image/")
  );
}

// ── Path traversal sanitiser ──────────────────────────────
// Allows alphanumeric, spaces, dots, dashes, underscores,
// parentheses and forward slashes — covers most collection names.
// Only strips genuinely dangerous characters.
function sanitisePath(key: string): string {
  return key
    .replace(/\.{2,}/g, ".")                   // collapse .. to prevent traversal
    .replace(/^\/+/, "")                        // strip leading slashes
    .replace(/\/+/g, "/")                       // collapse double slashes
    .replace(/[<>:"\\|?*\x00-\x1f]/g, "");     // strip dangerous chars only
}

// Validate path was not changed by sanitiser — if it was, it had bad chars
function isPathSafe(original: string, sanitised: string): boolean {
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
    // Normalise: lowercase + strip parameters e.g. "image/heic; charset=utf-8"
    const normalisedType = (contentType ?? "").toLowerCase().split(";")[0].trim();

    if (!normalisedType || !ALLOWED_MIME_TYPES.has(normalisedType)) {
      console.warn(
        `Rejected — disallowed type: "${contentType}" → "${normalisedType}" user=${user.id}`,
      );
      return new Response(
        JSON.stringify({
          error: "Something went wrong. Please try again.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    // ── Validation 3 — SVG explicit block ────────────────
    // SVG can contain embedded JavaScript — never allow regardless of MIME
    if (normalisedType.includes("svg")) {
      return new Response(
        JSON.stringify({ error: "Something went wrong. Please try again." }),
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
        JSON.stringify({ error: "Something went wrong. Please try again." }),
        { status: 400, headers: corsHeaders },
      );
    }

    // Log incoming request for debugging
    console.log(
      `Upload request — user=${user.id} key="${key}" type=${normalisedType} size=${fileSize ?? "unknown"}`,
    );

    // ── Validation 6 — Authorised path check ──────────────
    // Expected format: {ownerId}/{collectionName}/{filename}
    // Thumb format:    {ownerId}/{collectionName}/thumbs/{filename}
    const keyParts = safeKey.split("/");
    if (keyParts.length < 3) {
      return new Response(
        JSON.stringify({ error: "Something went wrong. Please try again." }),
        { status: 400, headers: corsHeaders },
      );
    }

    const keyOwnerId = keyParts[0];
    // keyParts[1] is always the collection name regardless of format:
    // {ownerId}/{collectionName}/{filename}        → keyParts[1] = collectionName
    // {ownerId}/{collectionName}/thumbs/{filename} → keyParts[1] = collectionName
    const collectionName = keyParts[1];

    const isOwner = keyOwnerId === user.id;

    if (!isOwner) {
      // Not the owner — verify they have explicit share access
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      // Two separate queries — avoids PostgREST .or() fragility
      // Check by recipient_id first (UUID match — exact and fast)
      const { data: shareByUserId } = await supabase
        .from("shared_collections")
        .select("id")
        .eq("owner_id", keyOwnerId)
        .eq("collection_name", collectionName)
        .eq("recipient_id", user.id)
        .maybeSingle();

      // Fall back to email match if no user ID match
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
          JSON.stringify({ error: "Something went wrong. Please try again." }),
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

    // ── S3 content type normalisation ─────────────────────
    // s3.ts always compresses to JPEG before uploading so the stored
    // file is always JPEG regardless of the original source format.
    // This mapping ensures the presigned URL is signed with the same
    // Content-Type that the PUT request will actually send.
    //
    // HEIC variants from all iOS versions (including older x-image/* types)
    // are mapped to image/jpeg — if we signed with x-image/heic but the
    // PUT sends image/jpeg, S3 returns 403 SignatureDoesNotMatch.
    const s3ContentType =
      normalisedType.includes("jpeg") ||
      normalisedType.includes("jpg") ||
      isHeicVariant(normalisedType)
        ? "image/jpeg"
        : normalisedType;

    const command = new PutObjectCommand({
      Bucket: Deno.env.get("S3_BUCKET")!,
      Key: safeKey,
      ContentType: s3ContentType,
      // Store original dimensions in S3 metadata if provided
      ...(width && height
        ? { Metadata: { width: String(width), height: String(height) } }
        : {}),
    });

    // Short expiry — 5 minutes is enough for any upload
    // Long-lived presigned URLs are a security risk if leaked
    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 300,
    });

    console.log(
      `Upload URL generated — user=${user.id} owner=${keyOwnerId} key=${safeKey} s3Type=${s3ContentType} size=${fileSize ?? "unknown"}`,
    );

    return new Response(
      JSON.stringify({ uploadUrl, key: safeKey }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: any) {
    console.error("generate-upload-url error:", error.message, error.stack);
    return new Response(
      JSON.stringify({ error: "Something went wrong. Please try again." }),
      { status: 500, headers: corsHeaders },
    );
  }
});