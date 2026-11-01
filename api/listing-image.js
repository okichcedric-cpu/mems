const { getListing } = require("./_lib");

// Stable image URL for link previews. Preview thumbnails are signed URLs that
// expire, so crawlers get this permanent address, which redirects to a fresh one.
module.exports = async (req, res) => {
  const listing = await getListing(String(req.query.id || ""));
  const url = listing && listing.previews && listing.previews.find(Boolean);
  if (!url) {
    res.statusCode = 302;
    res.setHeader("Location", "/og-image.jpg");
    return res.end();
  }
  // raw=1: stream the bytes from our own origin so the browser can draw the
  // image on a canvas (the CDN doesn't send CORS headers).
  if (req.query.raw) {
    const img = await fetch(url).catch(() => null);
    if (!img || !img.ok) {
      res.statusCode = 502;
      return res.end();
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", img.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.end(Buffer.from(await img.arrayBuffer()));
  }
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.setHeader("Cache-Control", "public, s-maxage=3600");
  res.end();
};
