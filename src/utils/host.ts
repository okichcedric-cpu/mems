import { Platform } from "react-native";

// The marketplace is the same app served from a second hostname
// (marketplace.mems-app.com → same Vercel deployment). Anything that should
// behave differently there asks this helper. Native builds are never the
// marketplace; buying is web-only.
export function isMarketplaceHost(): boolean {
  if (Platform.OS !== "web" || typeof window === "undefined") return false;
  return window.location.hostname.toLowerCase().startsWith("marketplace.");
}

// Origin of the marketplace site, for links that must leave the main site.
// On the marketplace host itself this is just the current origin; elsewhere
// it is derived from the current host so local/preview deployments keep
// working. Falls back to production.
export function marketplaceOrigin(): string {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const { protocol, hostname, port } = window.location;
    if (hostname.startsWith("marketplace.")) return window.location.origin;
    if (hostname === "www.mems-app.com" || hostname === "mems-app.com") {
      return "https://marketplace.mems-app.com";
    }
    // localhost / preview deployments: stay on the same origin.
    return `${protocol}//${hostname}${port ? `:${port}` : ""}`;
  }
  return "https://marketplace.mems-app.com";
}
