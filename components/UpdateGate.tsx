import { useEffect, useRef, useState } from 'react';
import { AppState, DeviceEventEmitter, View } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { AuraDialog } from './AuraDialog';
import { colors } from '../theme/colors';
import {
  checkOtaUpdate,
  checkOtaAvailable,
  fetchOtaUpdate,
  applyOtaUpdate,
  autoApplyOtaUpdate,
  checkApkUpdate,
  downloadAndInstallApk,
  type AuraRelease,
} from '../utils/updater';
import { OTA_TRIGGER_EVENT } from '../utils/push';
import { getUserInfo } from '../utils/auth';
import { otaHeld } from '../utils/otaGuard';
import { useSplashReady } from './AnimatedSplash';
import analytics from '../utils/analytics';

// The developer's own accounts. OTA bundles are pushed to every device, but
// only these surface the instant-reload prompt; everyone else updates
// silently. Not a secret — just account ids, and the popup gating is
// cosmetic. Keep old ids listed: pushes deliver per-DEVICE (JPush regId), so
// a phone re-logged into a new account still receives them, and the prompt
// gate silently ate the popup for exactly that reason (2026-07-03).
const DEV_UIDS = new Set([
  'bdb56d39-2343-4798-8d20-a1f39f426d66', // jiaxinggan@foxmail.com (original dev account)
  '8859b507-dda7-488b-89d3-293e4c906960', // current phone account
]);

// Invisible gate mounted at the app root.
//   OTA (L1, JS bundle):
//     - every device: launch + foreground + push silently fetch & stage the
//       bundle. NO prompt (纯无感). It then APPLIES itself at the first moment
//       nobody is looking:
//         · launch — the cold-start check runs BEHIND the splash: the splash
//           is held for the manifest check, and if a bundle is found, for its
//           download too, then the reload happens before any UI was shown. A
//           fresh install / long-dead relaunch runs TODAY's code in its first
//           session, and nobody sees a screen appear and then blink away.
//           Slow networks time out of the hold and fall to the path below;
//         · background apply — the moment the app is backgrounded, a staged
//           bundle reloads out of sight. Android users background constantly
//           but cold-start rarely; waiting for a cold start left them weeks
//           behind. Both paths defer while an import/auto-tag holds otaGuard.
//     - the dev device (DEV_UID) additionally pops an instant "立即重载" prompt
//       on a push, kept solely for fast iteration.
//   APK (L2, native): checked after the OTA stage; prompts if a newer build
//     exists. Mandatory updates suppress the cancel/scrim path so the app can't
//     be used on a build that's been hard-cut.
type Phase = 'idle' | 'prompt' | 'downloading';

// Splash-hold budgets for the launch check. No update = the splash is released
// after one manifest round-trip; a slow network (CN reaching a blocked CDN)
// gives up the hold and lets the background apply take the bundle instead.
const LAUNCH_CHECK_MS = 1200;
const LAUNCH_TOTAL_MS = 4000;

// Resolves undefined if `p` has not settled within `ms` (p keeps running).
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), Math.max(0, ms)))]);
}

export function UpdateGate() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [release, setRelease] = useState<AuraRelease | null>(null);
  const [mandatory, setMandatory] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // An OTA JS bundle has been fetched and is ready to apply via reloadAsync.
  const [otaReady, setOtaReady] = useState(false);
  const otaReadyRef = useRef(false);   // one is already staged — don't re-prompt/re-fetch
  const checkingRef = useRef(false);   // a check is in flight (de-dupe rapid foregrounds)
  const isDevRef = useRef(false);      // this device is logged in as the developer
  const { holdSplash } = useSplashReady();
  const phaseRef = useRef<Phase>('idle');   // background apply must not abort an APK download
  phaseRef.current = phase;

  useEffect(() => {
    let cancelled = false;
    // Resolve dev identity once — only the dev device shows the reload prompt.
    getUserInfo().then((u) => { if (!cancelled && u?.uid && DEV_UIDS.has(u.uid)) isDevRef.current = true; }).catch(() => {});

    // Check for an OTA bundle and stage it. Runs on launch AND every time the
    // app returns to the foreground, so a freshly published update is picked up
    // mid-session — the old flow only checked on launch and applied on the NEXT
    // cold start. No-ops in dev / before EAS Update is configured.
    // showPrompt → surface the instant-reload popup (dev only); otherwise stage
    // silently and let the next cold start apply it.
    const runOta = async (showPrompt: boolean) => {
      // Already staged: a dev push still surfaces the reload prompt; a
      // launch/foreground re-check does nothing.
      if (otaReadyRef.current) {
        if (showPrompt) setOtaReady(true);
        return;
      }
      if (checkingRef.current) return;
      checkingRef.current = true;
      try {
        const fetched = await checkOtaUpdate();
        if (!cancelled && fetched) {
          otaReadyRef.current = true;   // staged → applies on next cold start regardless
          analytics.capture('aura_ota_ready', { showPrompt });
          if (showPrompt) setOtaReady(true);
        }
      } finally {
        checkingRef.current = false;
      }
    };

    // Launch: check (and, if needed, download + reload) behind the splash.
    // Resolves false when the hold timed out before the manifest check answered.
    const launchOta = async (): Promise<boolean> => {
      const release = holdSplash();
      const t0 = Date.now();
      let reloading = false;
      try {
        const available = await within(checkOtaAvailable(), LAUNCH_CHECK_MS);
        if (available === undefined) return false;
        if (cancelled || !available) return true;
        const fetching = fetchOtaUpdate().then((ok) => {
          if (ok) {
            otaReadyRef.current = true;   // staged → background apply / next cold start
            analytics.capture('aura_ota_ready', { showPrompt: false });
          }
          return ok;
        });
        const fetched = await within(fetching, LAUNCH_TOTAL_MS - (Date.now() - t0));
        if (cancelled || !fetched || otaHeld()) return true;
        analytics.capture('aura_ota_launch_heal', { ms: Date.now() - t0 });
        reloading = await autoApplyOtaUpdate().catch(() => false);
        return true;
      } finally {
        // Reloading: the splash stays up until the JS world is torn down.
        if (!reloading) release();
      }
    };

    (async () => {
      // Check timed out behind the splash: stage in the background instead.
      if (!(await launchOta())) void runOta(false);
      const apk = await checkApkUpdate();   // L2 (native) — separate prompt
      if (cancelled || !apk) return;
      setRelease(apk.release);
      setMandatory(apk.mandatory);
      setPhase('prompt');
      analytics.capture('aura_update_prompt', {
        version: apk.release.version,
        mandatory: apk.mandatory,
      });
    })();

    // Re-check when the app comes back to the foreground (switch desktop→phone
    // after publishing an OTA → it's picked up without a restart).
    // Background apply: the moment the user looks away, a staged bundle
    // reloads — they come back to the new version with zero visible churn.
    // Skipped while an import/auto-tag is in flight (otaGuard) or the APK
    // downloader is running; those staged bundles land on a later background
    // or the next cold start, same as before.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void runOta(false);   // foreground — silent stage
      if (
        s === 'background' &&
        otaReadyRef.current &&
        !otaHeld() &&
        phaseRef.current !== 'downloading'
      ) {
        analytics.capture('aura_ota_bg_apply', {});
        void autoApplyOtaUpdate().catch(() => {});
      }
    });
    // Push-driven: the server broadcasts a silent OTA-trigger after publishing,
    // so every running app pulls the bundle immediately (no polling). Only the
    // dev device surfaces the reload prompt; everyone else stages it silently.
    const otaSub = DeviceEventEmitter.addListener(
      OTA_TRIGGER_EVENT,
      () => void runOta(isDevRef.current),
    );
    return () => {
      cancelled = true;
      sub.remove();
      otaSub.remove();
    };
  }, []);

  const startInstall = async () => {
    if (!release) return;
    setProgress(0);
    setError(null);
    setPhase('downloading');
    try {
      await downloadAndInstallApk(release, setProgress);
      analytics.capture('aura_update_install_launched', { version: release.version });
      // The system installer is now foregrounded; reset so a returning user
      // (who declined the OS install) isn't stuck on the progress dialog.
      setPhase('idle');
    } catch (e) {
      console.warn('[UpdateGate] install failed', e);
      analytics.capture('aura_update_install_failed', { version: release.version });
      // Surface the failure (esp. for mandatory updates, where there's no
      // cancel — silent revert to the button leaves the user with no clue).
      setError('下载失败，请检查网络后重试');
      setPhase('prompt'); // let them retry
    }
  };

  // L1 (OTA / JS) reload prompt — only reached on the dev device (otaReady is
  // set only when showPrompt, i.e. a push on DEV_UID). Offers an instant reload
  // (no cold start). Shown only when no native-update dialog is up (APK prompt
  // takes priority); dismissable, and it still applies on the next cold start.
  if (otaReady && !(release && phase !== 'idle')) {
    return (
      <AuraDialog
        visible
        title="新版本已就绪"
        message="已拉取最新内容，点「立即重载」即刻生效（无需重启）。"
        confirmLabel="立即重载"
        onConfirm={() => { void applyOtaUpdate().catch(() => {}); }}
        cancelLabel="稍后"
        onClose={() => setOtaReady(false)}
      />
    );
  }

  if (phase === 'idle' || !release) return null;

  if (phase === 'downloading') {
    return (
      <AuraDialog visible title={`正在下载 v${release.version}`} onClose={() => {}}>
        <YStack gap={12} paddingTop={4}>
          <Text fontSize={13} color={colors.text.secondary} textAlign="center">
            下载完成后会自动拉起安装
          </Text>
          <View
            style={{
              height: 6,
              borderRadius: 3,
              backgroundColor: 'rgba(206,172,224,0.16)',
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                height: '100%',
                width: `${Math.round(progress * 100)}%`,
                borderRadius: 3,
                backgroundColor: colors.brand.primary,
              }}
            />
          </View>
          <Text fontSize={12} color={colors.text.tertiary} textAlign="center">
            {Math.round(progress * 100)}%
          </Text>
        </YStack>
      </AuraDialog>
    );
  }

  // phase === 'prompt'
  return (
    <AuraDialog
      visible
      title={`发现新版本 v${release.version}`}
      message={error || release.notes || '建议更新以获得最新功能与修复。'}
      confirmLabel={error ? '重试' : '立即更新'}
      onConfirm={startInstall}
      // Mandatory: no cancel button and scrim-dismiss is a no-op.
      cancelLabel={mandatory ? undefined : '稍后'}
      onClose={mandatory ? () => {} : () => setPhase('idle')}
    />
  );
}
