import { ScrollViewStyleReset } from "expo-router/html";
import { type PropsWithChildren } from "react";

// ── Root HTML document (web only)
const SITE_URL = "https://www.mems-app.com";
const OG_IMAGE_URL = `${SITE_URL}/og-image.jpg`;
const TITLE = "Mems – Your Digital Album for Life's Most Precious Moments";
const DESCRIPTION =
  "Keep your memories safe, beautifully organised, and shared with the people who matter most.";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />

        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <link rel="canonical" href={SITE_URL} />

        {/* ── Open Graph — WhatsApp, iMessage, Slack, Facebook, etc. ── */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Mems" />
        <meta property="og:url" content={SITE_URL} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:image" content={OG_IMAGE_URL} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta
          property="og:image:alt"
          content="Mems — your digital photo album"
        />

        {/* ── Twitter/X card — reads og:image/og:title on its own, but
            the explicit tags avoid relying on that fallback. ── */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <meta name="twitter:image" content={OG_IMAGE_URL} />

        {/* Disables body scrolling on native web platforms, at least
            temporarily, so Expo Router's <ScrollView> based navigators
            can control body scroll — the standard +html.tsx boilerplate,
            not specific to the meta tags above. */}
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
