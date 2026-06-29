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
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

// Max 15MB per image
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;

// ── Path traversal sanitiser ──────────────────────────────
// Strips anything that isn't alphanumeric, dot, dash, underscore or forward slash
// Collapses double dots to prevent ../../etc/passwd style attacks
function sanitisePath(key: string): string {
  return key
    .replace(/[^a-zA-Z0-9.\-_/]/g, "") // strip unsafe chars
    .replace(/\.{2,}/g, ".") // collapse .. to .
    .replace(/^\/+/, "") // strip leading slashes
    .replace(/\/+/g, "/"); // collapse double slashes
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
    // Reject anything not in the allowed set
    // Explicitly blocks SVG (can contain scripts), PDF, executable types
    if (!contentType || !ALLOWED_MIME_TYPES.has(contentType.toLowerCase())) {
      console.warn(
        `Rejected upload — disallowed content type: ${contentType} from user ${user.id}`,
      );
      return new Response(
        JSON.stringify({
          error: `File type not allowed: ${contentType ?? "unknown"}. Only JPEG, PNG, WebP, GIF and HEIC images are accepted.`,
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    // ── Validation 3 — SVG double-check ──────────────────
    // SVG can sneak through as image/svg+xml — block explicitly
    if (contentType.toLowerCase().includes("svg")) {
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
    if (!safeKey || safeKey !== key) {
      console.warn(
        `Rejected upload — unsafe path: "${key}" sanitised to "${safeKey}" from user ${user.id}`,
      );
      return new Response(
        JSON.stringify({ error: "Invalid file path" }),
        { status: 400, headers: corsHeaders },
      );
    }

    // ── Validation 6 — Key must be under the user's own prefix ──
    // Prevents a user from generating a presigned URL for another user's path
    // Expected format: {userId}/{collectionName}/{filename}
    const keyParts = safeKey.split("/");
    if (keyParts.length < 3) {
      return new Response(
        JSON.stringify({ error: "Invalid file path structure" }),
        { status: 400, headers: corsHeaders },
      );
    }

    const keyUserId = keyParts[0];
    if (keyUserId !== user.id) {
      console.warn(
        `Rejected upload — user ${user.id} attempted to write to path owned by ${keyUserId}`,
      );
      return new Response(
        JSON.stringify({ error: "You can only upload to your own storage path." }),
        { status: 403, headers: corsHeaders },
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

    const command = new PutObjectCommand({
      Bucket: Deno.env.get("S3_BUCKET")!,
      Key: safeKey,
      ContentType: contentType,
      // Store image dimensions in metadata if provided
      ...(width && height
        ? { Metadata: { width: String(width), height: String(height) } }
        : {}),
    });

    // Short expiry — 5 minutes is enough for any upload
    // Long-lived presigned URLs are a security risk
    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 300,
    });

    console.log(
      `Generated upload URL for user ${user.id} — key: ${safeKey} type: ${contentType} size: ${fileSize ?? "unknown"}`,
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