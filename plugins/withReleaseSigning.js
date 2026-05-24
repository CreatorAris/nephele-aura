// Expo config plugin — injects the Android release signingConfig into the
// generated android/app/build.gradle so it survives every `expo prebuild`.
//
// Credentials are NOT stored here or in the repo. They live in the user-global
// ~/.gradle/gradle.properties (AURA_UPLOAD_*), which gradle reads at build time.
// Keystore file: D:\For_emergency? -> actually E:/For_emergency/aura-release.keystore
// (path set via AURA_UPLOAD_STORE_FILE). If the props are absent (e.g. CI without
// them), release falls back to the debug key so the build still succeeds.
const { withAppBuildGradle } = require('@expo/config-plugins');

const RELEASE_SIGNING_CONFIG = `
        // Injected by plugins/withReleaseSigning.js — reads AURA_UPLOAD_* from
        // the user-global ~/.gradle/gradle.properties (never committed).
        release {
            if (project.hasProperty('AURA_UPLOAD_STORE_FILE')) {
                storeFile file(AURA_UPLOAD_STORE_FILE)
                storePassword AURA_UPLOAD_STORE_PASSWORD
                keyAlias AURA_UPLOAD_KEY_ALIAS
                keyPassword AURA_UPLOAD_KEY_PASSWORD
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;

    // 1. Add a `release` signingConfig right before signingConfigs' closing brace.
    if (!src.includes('AURA_UPLOAD_STORE_FILE')) {
      src = src.replace(
        /\n    \}\n    buildTypes \{/,
        `\n${RELEASE_SIGNING_CONFIG}\n    }\n    buildTypes {`,
      );
    }

    // 2. Point the release buildType at it (fallback to debug if props missing).
    // Anchor on the Expo template's release-only comment so we never touch the
    // debug buildType's signingConfig (which also reads `signingConfigs.debug`).
    src = src.replace(
      /(signed-apk-android\.\s*\n\s*)signingConfig signingConfigs\.debug/,
      `$1signingConfig project.hasProperty('AURA_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug`,
    );

    cfg.modResults.contents = src;
    return cfg;
  });
};
