// Aura self-update — two layers, mirroring the desktop's split:
//   L1 OTA  (expo-updates / EAS Update): JS-bundle updates, ~90% of iteration.
//            Silent: fetched in the background, applied on next cold start.
//   L2 APK  (self-distributed builds): native changes require a new APK.
//            Worker /v1/aura/release is the manifest; we download + fire the
//            Android install intent. Android-only (iOS can't sideload).
//
// Guards: OTA no-ops until EAS is configured (Updates.isEnabled) and in dev.
// The APK path is Android-only and fails soft — an update check must never
// crash app launch.
import * as Updates from 'expo-updates';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

const API_BASE = 'https://api.arisfusion.com';
const CLIENT_TYPE = 'nephele-aura';

// ---------------------------------------------------------------------------
// L1 — OTA (expo-updates)
// ---------------------------------------------------------------------------

/**
 * Check for a JS-bundle update and download it in the background.
 * Returns true if a new bundle was fetched (it applies on the next cold start;
 * we deliberately do NOT call reloadAsync() so the current session isn't
 * interrupted). No-ops in dev or before EAS Update is configured.
 */
export async function checkOtaUpdate(): Promise<boolean> {
  if (__DEV__ || !Updates.isEnabled) return false;
  try {
    const res = await Updates.checkForUpdateAsync();
    if (!res.isAvailable) return false;
    await Updates.fetchUpdateAsync();
    stagedId = (res.manifest as { id?: string } | undefined)?.id ?? null;
    return true;
  } catch (e) {
    console.warn('[OTA] check failed', e);
    return false;
  }
}

// Id of the update the last checkOtaUpdate() staged; null when unknown.
let stagedId: string | null = null;
const AUTO_APPLIED_KEY = 'ota.autoAppliedId';

/**
 * The UNATTENDED apply (launch catch-up, background apply): at most one
 * automatic reload per update id, remembered across launches. If a reload
 * does not land on the staged update — 2026-09-21: an APK whose embedded
 * manifest predated the live OTA kept relaunching into the embedded bundle —
 * the next check reports it available again, and an unconditional reload
 * becomes an endless loop the user cannot escape. A second attempt is left
 * to the next cold start, which needs no reload.
 */
export async function autoApplyOtaUpdate(): Promise<void> {
  if (__DEV__ || !Updates.isEnabled || !stagedId) return;
  const last = await AsyncStorage.getItem(AUTO_APPLIED_KEY).catch(() => null);
  if (last === stagedId) return;
  await AsyncStorage.setItem(AUTO_APPLIED_KEY, stagedId);
  await Updates.reloadAsync();
}

/**
 * Apply an already-fetched OTA bundle NOW by reloading the JS into it — no app
 * restart, no cold start. Call after checkOtaUpdate() returned true and the user
 * opted in (see UpdateGate's reload prompt). No-ops in dev / when OTA is off.
 */
export async function applyOtaUpdate(): Promise<void> {
  if (__DEV__ || !Updates.isEnabled) return;
  await Updates.reloadAsync();
}

// ---------------------------------------------------------------------------
// L2 — APK self-update (Android, self-distributed)
// ---------------------------------------------------------------------------

export type AuraRelease = {
  version: string;        // semver of the latest APK
  runtimeVersion: string; // fingerprint it was built against
  apkUrl: string;         // R2 URL (immutable per version)
  notes?: string;         // changelog shown in the prompt
  minVersion?: string;    // versions below this must update (mandatory)
  mandatory?: boolean;    // force update regardless of minVersion
};

/** Compare two semver-ish strings. Returns 1 if a > b, -1 if a < b, else 0. */
function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export type ApkUpdate = { release: AuraRelease; mandatory: boolean };

/**
 * Ask the Worker for the latest APK and decide whether this build is behind.
 * Android-only; returns null when up to date or on any failure.
 */
export async function checkApkUpdate(): Promise<ApkUpdate | null> {
  if (Platform.OS !== 'android') return null;
  try {
    const res = await fetch(`${API_BASE}/v1/aura/release`, {
      headers: { 'X-Client-Type': CLIENT_TYPE },
    });
    if (!res.ok) return null;
    const { release } = (await res.json()) as { release: AuraRelease | null };
    if (!release?.apkUrl || !release.version) return null;

    // The release manifest is the only trust point; never download/install an
    // APK from an arbitrary host it might name. Pin to our own CDN.
    if (!release.apkUrl.startsWith('https://download.arisfusion.com/')) {
      console.warn('[APK] untrusted apkUrl host, ignoring');
      return null;
    }

    const current = Constants.expoConfig?.version ?? '0.0.0';
    if (cmpSemver(release.version, current) <= 0) return null; // already current

    const mandatory =
      release.mandatory === true ||
      (!!release.minVersion && cmpSemver(release.minVersion, current) > 0);
    return { release, mandatory };
  } catch (e) {
    console.warn('[APK] check failed', e);
    return null;
  }
}

/**
 * Download the APK to cache and launch the system installer. The user still
 * confirms the install (and grants "install unknown apps" the first time).
 * onProgress reports 0..1.
 */
export async function downloadAndInstallApk(
  release: AuraRelease,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const target = `${FileSystem.cacheDirectory}aura-${release.version}.apk`;

  // Drop any stale partial from a previous attempt.
  try {
    const info = await FileSystem.getInfoAsync(target);
    if (info.exists) await FileSystem.deleteAsync(target, { idempotent: true });
  } catch {
    /* non-fatal */
  }

  const dl = FileSystem.createDownloadResumable(
    release.apkUrl,
    target,
    {},
    (p) => {
      if (p.totalBytesExpectedToWrite > 0) {
        onProgress?.(p.totalBytesWritten / p.totalBytesExpectedToWrite);
      }
    },
  );

  const result = await dl.downloadAsync();
  if (!result?.uri) throw new Error('APK download failed');

  // content:// URI via Expo's FileProvider; grant the installer read access.
  const contentUri = await FileSystem.getContentUriAsync(result.uri);
  await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
  });
}
