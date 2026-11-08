const { getListing, esc } = require("./_lib");

// Served to link-preview crawlers (WhatsApp, Facebook, X, Telegram, ...) for
// /listing/:id. They don't run JavaScript, so this returns the Open Graph tags
// for that specific collection. People who open the link land on the real page.
module.exports = async (req, res) => {
  const id = String(req.query.id || "");
  const listing = await getListing(id);
  const host = req.headers["x-forwarded-host"] || req.headers.host || "marketplace.mems-app.com";
  const origin = `https://${host}`;
  const pageUrl = `${origin}/listing/${encodeURIComponent(id)}`;

  let title = "Picture Board Marketplace";
  let desc = "Buy whole photo collections from creators.";
  let image = `${origin}/og-image.jpg`;
  if (listing) {
    const price = `${listing.currency} ${Number(listing.priceAmount).toLocaleString("en-US")}`;
    title = `${listing.title} · ${price}`;
    const body = (listing.description || "").trim();
    desc = `${body ? body + " — " : ""}${listing.photoCount} photos by ${listing.seller.displayName}`.slice(0, 300);
    image = `${origin}/api/listing-image?id=${encodeURIComponent(id)}`;
  }

  res.statusCode = listing ? 200 : 404;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Picture Board Marketplace">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="canonical" href="${esc(pageUrl)}">
</head><body><a href="${esc(pageUrl)}">${esc(title)}</a></body></html>`);
};
