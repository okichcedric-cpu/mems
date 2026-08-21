// Bakes SENTRY_AUTH_TOKEN into android/sentry.properties at prebuild time.
//
// Why this exists: @sentry/react-native/expo's own config plugin
// deliberately leaves auth.token out of sentry.properties and falls back
// to reading the SENTRY_AUTH_TOKEN environment variable at Gradle-build
// time instead (see the "# Using SENTRY_AUTH_TOKEN environment variable"
// comment it writes). That's fine when building via `eas build` or
// `npx expo run:android`, which both load .env files before invoking
// Gradle — but Android Studio, launched directly (not from a terminal
// that has sourced those vars), does NOT inherit them, so the bundled
// sentry-cli has no token and the release build's source-map upload task
// fails outright: "Process 'command sentry-cli' finished with non-zero
// exit value 1".
//
// `expo prebuild` itself IS run through the Expo CLI, which loads
// .env/.env.local before evaluating config plugins — so at THIS point in
// the pipeline (not at Gradle-build time) process.env.SENTRY_AUTH_TOKEN
// is reliably available regardless of how the eventual Gradle build gets
// launched. Writing the real token into sentry.properties here — a file
// that's already gitignored (the whole android/ directory is, since it's
// regenerated on every prebuild) — makes it durable across launch
// methods without depending on Gradle ever seeing the env var itself.
//
// Ordering note (easy to get backwards): expo-modules-core's
// withDangerousMod chains run in the REVERSE of plugins-array order —
// the last-listed plugin's dangerous-mod action actually executes
// FIRST, then hands off to the previously-registered one. Since Sentry's
// plugin needs to write the base sentry.properties (org/project/url)
// BEFORE this one appends auth.token, this plugin must be listed EARLIER
// in app.json's plugins array than "@sentry/react-native/expo" — not
// after, which is the intuitive-but-wrong ordering and was the actual
// bug the first time this was wired up (both files got rewritten, but
// Sentry's base write clobbered this one's auth.token line because this
// plugin ran first, not last).
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

module.exports = function withSentryAuthToken(config) {
  return withDangerousMod(config, [
    "android",
    (config) => {
      const authToken = process.env.SENTRY_AUTH_TOKEN;
      if (!authToken) {
        // No token available at prebuild time — leave whatever
        // sentry.properties already has (the env-var-fallback comment)
        // untouched rather than writing an empty/broken line.
        return config;
      }

      const propsPath = path.resolve(
        config.modRequest.projectRoot,
        "android",
        "sentry.properties",
      );
      const existing = fs.existsSync(propsPath)
        ? fs.readFileSync(propsPath, "utf8")
        : "";

      const withoutAuthLines = existing
        .split("\n")
        .filter(
          (line) =>
            !line.startsWith("auth.token=") &&
            !line.includes("Using SENTRY_AUTH_TOKEN environment variable") &&
            !line.includes("DO NOT COMMIT the auth token"),
        )
        .join("\n")
        .trimEnd();

      fs.writeFileSync(propsPath, `${withoutAuthLines}\nauth.token=${authToken}\n`);

      return config;
    },
  ]);
};
