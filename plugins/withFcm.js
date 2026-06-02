// Expo config plugin — wires JPush's overseas Google/FCM channel into the
// native Android project so it survives `expo prebuild --clean` (android/ is
// gitignored / CNG). Mirrors withHmsPush. JPush auto-routes GMS devices via
// FCM; the JPush RegistrationID and all JS/Worker push logic stay unchanged
// ("原本 JPush 的所有接口调用逻辑都不用修改").
//
// No-op until `google-services.json` exists at the project root: the
// google-services gradle plugin HARD-FAILS the build when the file is missing,
// so we only wire FCM once it's dropped in (mirrors withJPush's empty-appKey
// no-op). google-services.json is the CLIENT config from the Firebase console
// (Android app, package com.creatoraris.nephele.aura). Separately, the FCM
// service-account key JSON (HTTP v1) is uploaded to the JPush console to let
// JPush servers SEND via FCM — that file is NOT used by this plugin.
const {
  withProjectBuildGradle,
  withAppBuildGradle,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// google-services gradle plugin — 4.4.x supports AGP 8.x (the project pins AGP
// 8.11.0 in withHmsPush). JPush's doc lists an older 4.3.8; bumped for AGP 8.
const GOOGLE_SERVICES_VERSION = '4.4.2';
// == bundled cn.jiguang.sdk:jpush (same version as the huawei plugin). The fcm
// plugin >=5.9.0 auto-pulls firebase-messaging, so we don't declare it here.
const JPUSH_FCM_VERSION = '6.1.0';

function hasGoogleServices(projectRoot) {
  return fs.existsSync(path.join(projectRoot, 'google-services.json'));
}

module.exports = function withFcm(config) {
  // 1. Root build.gradle — google-services classpath.
  config = withProjectBuildGradle(config, (cfg) => {
    if (!hasGoogleServices(cfg.modRequest.projectRoot)) return cfg;
    let s = cfg.modResults.contents;
    if (!s.includes('com.google.gms:google-services')) {
      const next = s.replace(
        "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')",
        `classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')\n    classpath('com.google.gms:google-services:${GOOGLE_SERVICES_VERSION}')`,
      );
      if (next === s) {
        console.warn('[withFcm] kotlin-gradle-plugin classpath anchor not found — google-services classpath not added; FCM build will fail');
      }
      s = next;
    }
    cfg.modResults.contents = s;
    return cfg;
  });

  // 2. app/build.gradle — apply google-services plugin + JPush fcm plugin.
  config = withAppBuildGradle(config, (cfg) => {
    if (!hasGoogleServices(cfg.modRequest.projectRoot)) return cfg;
    let s = cfg.modResults.contents;
    if (!s.includes('com.google.gms.google-services')) {
      s = s.replace(
        'apply plugin: "com.facebook.react"',
        'apply plugin: "com.facebook.react"\napply plugin: "com.google.gms.google-services"',
      );
    }
    if (!s.includes('cn.jiguang.sdk.plugin:fcm')) {
      s = s.replace(
        'implementation("com.facebook.react:react-android")',
        'implementation("com.facebook.react:react-android")\n'
          + `    implementation("cn.jiguang.sdk.plugin:fcm:${JPUSH_FCM_VERSION}")`,
      );
    }
    cfg.modResults.contents = s;
    return cfg;
  });

  // 3. Copy google-services.json (project root → android/app/).
  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'google-services.json');
      if (!fs.existsSync(src)) {
        console.warn('[withFcm] google-services.json not found at project root — FCM channel disabled (no-op).');
        return cfg;
      }
      const dest = path.join(cfg.modRequest.platformProjectRoot, 'app', 'google-services.json');
      fs.copyFileSync(src, dest);
      return cfg;
    },
  ]);

  return config;
};
