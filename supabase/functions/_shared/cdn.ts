import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "npm:@aws-sdk/client-cloudfront";
import { getSignedUrl as getCloudFrontSignedUrl } from "npm:@aws-sdk/cloudfront-signer";
import { GetObjectCommand, type S3Client } from "npm:@aws-sdk/client-s3";
import { getSignedUrl as getS3SignedUrl } from "npm:@aws-sdk/s3-request-presigner";

// ── CloudFront read-URL helper ───────────────────────────────────────────
// Every image read URL in the app goes through signedReadUrl() so the CDN
// rollout is a single switch: when CLOUDFRONT_DOMAIN (plus the key pair
// below) is set, URLs are CloudFront signed URLs; when it isn't, this falls
// straight back to the old S3 presigned URLs. Unsetting CLOUDFRONT_DOMAIN
// is the rollback.
//
// Secrets (supabase secrets set ...):
//   CLOUDFRONT_DOMAIN          e.g. d1234abcd.cloudfront.net (no scheme)
//   CLOUDFRONT_KEY_PAIR_ID     the public key's ID (starts with K...)
//   CLOUDFRONT_PRIVATE_KEY     PEM private key (literal "\n" is fine)
//   CLOUDFRONT_DISTRIBUTION_ID only needed for invalidateCdn()
//
// Expiry: URLs are valid for 24-36h and — importantly — the expiry is
// snapped to a fixed 12h grid, so the SAME photo gets the SAME URL for up
// to 12h. Browsers cache by full URL, so a URL that changes on every call
// (as presigned S3 URLs do) means web never gets a cache hit.
// CloudFront ignores the signature query params in its own cache key, so
// all users share one edge copy regardless.
const WINDOW_SECONDS = 12 * 60 * 60;
const TTL_SECONDS = 36 * 60 * 60;

function cdnConfig() {
  const domain = Deno.env.get("CLOUDFRONT_DOMAIN");
  const keyPairId = Deno.env.get("CLOUDFRONT_KEY_PAIR_ID");
  const privateKey = Deno.env.get("CLOUDFRONT_PRIVATE_KEY");
  if (!domain || !keyPairId || !privateKey) return null;
  return {
    domain: domain.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    keyPairId,
    privateKey: privateKey.replace(/\\n/g, "\n"),
  };
}

export function cdnEnabled(): boolean {
  return cdnConfig() !== null;
}

// Per-segment encoding: keys contain spaces/parentheses (see the
// sanitiser's allowed charset), and the path in the URL must be encoded.
// CloudFront forwards the decoded path to S3, so it resolves to the key.
function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export async function signedReadUrl(
  s3: S3Client,
  bucket: string,
  key: string,
  // Only used on the S3 fallback path, to preserve each caller's old expiry.
  fallbackExpiresIn = 86400,
): Promise<string> {
  const cfg = cdnConfig();
  if (!cfg) {
    return await getS3SignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: fallbackExpiresIn },
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expires =
    Math.floor(nowSeconds / WINDOW_SECONDS) * WINDOW_SECONDS + TTL_SECONDS;

  return getCloudFrontSignedUrl({
    url: `https://${cfg.domain}/${encodeKeyPath(key)}`,
    keyPairId: cfg.keyPairId,
    privateKey: cfg.privateKey,
    dateLessThan: new Date(expires * 1000).toISOString(),
  });
}

// Best-effort edge invalidation after a delete/rename, so a removed photo
// stops being served from cache. Never throws — a failed invalidation must
// not fail the delete the user asked for (worst case the object lingers at
// the edge until the cache TTL ends, and signed URLs expire within 36h
// anyway). Paths are key paths WITHOUT a leading slash; "*" wildcards allowed
// (a wildcard counts as one invalidation path for billing).
export async function invalidateCdn(keyPaths: string[]): Promise<void> {
  const distributionId = Deno.env.get("CLOUDFRONT_DISTRIBUTION_ID");
  if (!cdnEnabled() || !distributionId || keyPaths.length === 0) return;

  try {
    const client = new CloudFrontClient({
      region: "us-east-1",
      credentials: {
        accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
        secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
      },
    });
    const items = keyPaths.map((p) => `/${encodeKeyPath(p.replace(/\*$/, ""))}${p.endsWith("*") ? "*" : ""}`);
    await client.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: `${Date.now()}-${crypto.randomUUID()}`,
          Paths: { Quantity: items.length, Items: items },
        },
      }),
    );
  } catch (error: any) {
    console.warn("invalidateCdn failed (non-fatal):", error?.message);
  }
}
