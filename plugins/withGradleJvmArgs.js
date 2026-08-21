// Bumps org.gradle.jvmargs in android/gradle.properties. Needed because
// this project hit a Gradle "Out of memory. Metaspace" build failure once
// expo-iap's native modules pushed class-loading past the default
// 512m Metaspace cap (New Architecture + more autolinked native modules
// mean more classes get loaded at build time than the Expo template's
// default JVM args were sized for).
//
// android/ is regenerated on every `expo prebuild`, so a manual edit to
// gradle.properties doesn't survive — this config plugin is what makes
// the bump durable across prebuilds. See the withGradleProperties usage
// in expo-iap's own plugin (node_modules/expo-iap/plugin/build/withIAP.js)
// for the pattern this follows.
const { withGradleProperties } = require("@expo/config-plugins");

const JVM_ARGS = "-Xmx4096m -XX:MaxMetaspaceSize=1024m";

module.exports = function withGradleJvmArgs(config) {
  return withGradleProperties(config, (config) => {
    config.modResults = config.modResults.filter(
      (item) => item.type !== "property" || item.key !== "org.gradle.jvmargs",
    );
    config.modResults.push({
      type: "property",
      key: "org.gradle.jvmargs",
      value: JVM_ARGS,
    });
    return config;
  });
};
