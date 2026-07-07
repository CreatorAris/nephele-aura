// Expo config plugin — enable cleartext HTTP on the RELEASE Android manifest so
// Aura can reach the desktop's LAN file server (http://192.168.x.x:<port>) for
// the direct-import / browse fast path. targetSdk>=28 release builds block
// cleartext by default, so without this LAN transport silently falls back to the
// cloud relay. The `android.usesCleartextTraffic` key in app.json is NOT a
// recognized Expo field, so it never reached the manifest — hence this plugin.
// (Android NSC can't scope cleartext to a CIDR and the desktop IP is dynamic, so
// this is blanket; the rest of the app addresses HTTPS endpoints anyway.)
const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

module.exports = function withCleartext(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
};
