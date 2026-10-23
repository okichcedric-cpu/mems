// ── Signed unsubscribe tokens ───────────────────────────────────────────
// The unsubscribe link in the nudge email carries `u` (user id) and `t`
// (HMAC-SHA256 of the user id, keyed by UNSUBSCRIBE_SECRET). Only the server
// can produce a valid `t`, so nobody can unsubscribe someone else by editing
// the link — and no login is needed to use it, which is what an email
// unsubscribe link has to allow.

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function signUnsubscribeToken(userId: string): Promise<string> {
  const secret = Deno.env.get("UNSUBSCRIBE_SECRET");
  if (!secret) throw new Error("UNSUBSCRIBE_SECRET is not set");
  return hmacHex(secret, `unsubscribe:${userId}`);
}

export async function verifyUnsubscribeToken(
  userId: string,
  token: string,
): Promise<boolean> {
  const secret = Deno.env.get("UNSUBSCRIBE_SECRET");
  if (!secret || !userId || !token) return false;
  const expected = await hmacHex(secret, `unsubscribe:${userId}`);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}
