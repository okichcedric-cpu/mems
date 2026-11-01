// Shared helpers for the share-preview functions.
const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL || "https://haguvnkejfbmjwsuipsz.supabase.co";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getListing(id) {
  if (!UUID.test(id)) return null;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/marketplace-listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "get", id }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data && data.listing ? data.listing : null;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

module.exports = { getListing, esc, UUID };
