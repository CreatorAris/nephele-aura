// Expo config plugin — wires jpush-react-native's required manifestPlaceholders
// into android/app/build.gradle so they survive every `expo prebuild`. The
// JPush AppKey is read from app.json `extra.jpushAppKey`; if it's empty the
// plugin is a no-op (push stays dormant and the native build is unaffected).
// jpush-react-native autolinks its native package (RN 0.60+), so no
// MainApplication edit is needed — only these placeholders.
const { withAppBuildGradle } = require('@expo/config-plugins');

module.exports = function withJPush(config) {
  const appKey =
    (config.extra && config.extra.jpushAppKey) ||
    (config.expo && config.expo.extra && config.expo.extra.jpushAppKey) ||
    '';
  if (!appKey) return config;

  // Package name as a literal — do NOT reference Groovy `applicationId` here:
  // the placeholders block is injected right after `defaultConfig {`, i.e.
  // BEFORE the `applicationId` line, so `applicationId` is still null at eval
  // time → AGP fails with "Cannot invoke Object.toString() because value is null".
  const pkg =
    (config.android && config.android.package) ||
    (config.expo && config.expo.android && config.expo.android.package) ||
    '';

  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes('JPUSH_APPKEY')) return cfg; // idempotent

    const placeholders = `
        // Injected by plugins/withJPush.js — JPush/JCore manifest placeholders.
        manifestPlaceholders = [
            JPUSH_PKGNAME: "${pkg}",
            JPUSH_APPKEY : "${appKey}",
            JPUSH_CHANNEL: "developer-default",
        ]`;

    // Insert right after the defaultConfig opening brace.
    const next = src.replace(/defaultConfig\s*\{/, (m) => `${m}${placeholders}`);
    if (next === src) {
      console.warn('[withJPush] defaultConfig anchor not found — JPUSH_APPKEY not injected; push will not init');
    }
    cfg.modResults.contents = next;
    return cfg;
  });
};
