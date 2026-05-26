// Expo config plugin — wires the JPush Huawei vendor channel (HMS Push) into
// the native Android project so it survives `expo prebuild --clean` (android/
// is gitignored / CNG). Mirrors the manually-verified setup:
//   - project build.gradle: HMS maven repo (buildscript + allprojects),
//     AGConnect agcp classpath, and an explicit AGP version (agcp parses the
//     version literal and fails with "is no set" when Expo leaves it implicit).
//   - app build.gradle: apply the agconnect plugin + HMS push + the JPush
//     huawei plugin (version MUST match bundled cn.jiguang.sdk:jpush:6.1.0).
//   - copy agconnect-services.json from the project root into android/app/.
// Verified on a Huawei device: killed-app delivery works once the signing
// cert's SHA-256 is registered in AGC.
const {
  withProjectBuildGradle,
  withAppBuildGradle,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Keep in sync with @react-native/gradle-plugin's libs.versions.toml `agp`.
const AGP_VERSION = '8.11.0';
const AGCP_VERSION = '1.9.1.301';
const HMS_PUSH_VERSION = '6.13.0.300';
const JPUSH_HUAWEI_VERSION = '6.1.0'; // == bundled cn.jiguang.sdk:jpush
const HMS_REPO = "maven { url 'https://developer.huawei.com/repo/' }";

module.exports = function withHmsPush(config) {
  // 1. Root build.gradle
  config = withProjectBuildGradle(config, (cfg) => {
    let s = cfg.modResults.contents;
    // Pin AGP version so the agcp plugin can detect it.
    const pinned = s.replace(
      "classpath('com.android.tools.build:gradle')",
      `classpath('com.android.tools.build:gradle:${AGP_VERSION}')`,
    );
    if (pinned === s) {
      console.warn('[withHmsPush] AGP classpath anchor not found — version not pinned; Huawei push may fail silently');
    }
    s = pinned;
    // AGConnect gradle plugin classpath.
    if (!s.includes('com.huawei.agconnect:agcp')) {
      s = s.replace(
        "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')",
        `classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')\n    classpath('com.huawei.agconnect:agcp:${AGCP_VERSION}')`,
      );
    }
    // HMS maven repo in both buildscript.repositories and allprojects.repositories.
    if (!s.includes('developer.huawei.com/repo')) {
      s = s.replace(/mavenCentral\(\)/g, `mavenCentral()\n    ${HMS_REPO}`);
    }
    cfg.modResults.contents = s;
    return cfg;
  });

  // 2. app/build.gradle
  config = withAppBuildGradle(config, (cfg) => {
    let s = cfg.modResults.contents;
    if (!s.includes('com.huawei.agconnect')) {
      s = s.replace(
        'apply plugin: "com.facebook.react"',
        'apply plugin: "com.facebook.react"\napply plugin: "com.huawei.agconnect"',
      );
    }
    if (!s.includes('com.huawei.hms:push')) {
      s = s.replace(
        'implementation("com.facebook.react:react-android")',
        'implementation("com.facebook.react:react-android")\n'
          + `    implementation("com.huawei.hms:push:${HMS_PUSH_VERSION}")\n`
          + `    implementation("cn.jiguang.sdk.plugin:huawei:${JPUSH_HUAWEI_VERSION}")`,
      );
    }
    cfg.modResults.contents = s;
    return cfg;
  });

  // 3. Copy agconnect-services.json (project root → android/app/).
  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'agconnect-services.json');
      const dest = path.join(cfg.modRequest.platformProjectRoot, 'app', 'agconnect-services.json');
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      } else {
        console.warn('[withHmsPush] agconnect-services.json not found at project root — Huawei channel will not work.');
      }
      return cfg;
    },
  ]);

  return config;
};
