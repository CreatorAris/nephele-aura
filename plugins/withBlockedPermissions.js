// Expo config plugin — strip transitive Android permissions Aura never uses, so
// `expo prebuild` (android/ is CNG / gitignored) regenerates a CLEAN manifest
// instead of silently reintroducing them on every native rebuild.
//
// Pulled in (and removed here) by:
//   - JPush 6.1.0 → ACCESS_*_LOCATION ×3, READ_PHONE_STATE, GET_TASKS
//     (geo-targeting + device fingerprinting we don't use; push delivery is
//     registration-id based, so dropping these doesn't affect notifications)
//   - expo-camera → RECORD_AUDIO (we only scan the desktop pairing QR; no audio)
//
// Deliberately NOT blocked: QUERY_ALL_PACKAGES and SYSTEM_ALERT_WINDOW —
// JPush's vendor-channel routing (华为/小米/OPPO/vivo) may rely on them, and
// the whole point of JPush here is GMS-less vendor delivery.
//
// tools:node="remove" wins the manifest merge, so the shipped APK ends up with
// only CAMERA + POST_NOTIFICATIONS (+ the standard INTERNET/network set).
const { AndroidConfig } = require('@expo/config-plugins');

const BLOCKED = [
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.READ_PHONE_STATE',
  'android.permission.GET_TASKS',
  'android.permission.RECORD_AUDIO',
];

module.exports = function withBlockedPermissions(config) {
  return AndroidConfig.Permissions.withBlockedPermissions(config, BLOCKED);
};
