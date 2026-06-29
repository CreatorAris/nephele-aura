import { useEffect, useRef, useState } from 'react';
import { AppState, DeviceEventEmitter, View } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { AuraDialog } from './AuraDialog';
import { colors } from '../theme/colors';
import {
  checkOtaUpdate,
  applyOtaUpdate,
  checkApkUpdate,
  downloadAndInstallApk,
  type AuraRelease,
} from '../utils/updater';
import { OTA_TRIGGER_EVENT } from '../utils/push';
import analytics from '../utils/analytics';

// Invisible gate mounted at the app root.
//   OTA (L1, JS bundle):
//     - launch + every foreground: silently fetch & stage → applies on the next
//       cold start. NO prompt — users update seamlessly (纯无感).
//     - dev push-trigger (only AURA_DEV_UID gets the push): surfaces an instant
//       "立即重载" prompt, kept solely for fast dev iteration.
//   APK (L2, native): checked after the OTA stage; prompts if a newer build
//     exists. Mandatory updates suppress the cancel/scrim path so the app can't
//     be used on a build that's been hard-cut.
type Phase = 'idle' | 'prompt' | 'downloading';

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

  useEffect(() => {
    let cancelled = false;

    // Check for an OTA bundle and stage it. Runs on launch AND every time the
    // app returns to the foreground, so a freshly published update is picked up
    // mid-session — the old flow only checked on launch and applied on the NEXT
    // cold start. No-ops in dev / before EAS Update is configured.
    // viaPush = the dev OTA-trigger message (only AURA_DEV_UID receives it).
    // Only that path surfaces the instant-reload prompt; launch/foreground
    // checks (which every user runs) stage the bundle silently → next cold
    // start applies it with no popup.
    const runOta = async (viaPush: boolean) => {
      // Already staged: a dev push still surfaces the reload prompt; a
      // launch/foreground re-check does nothing.
      if (otaReadyRef.current) {
        if (viaPush) setOtaReady(true);
        return;
      }
      if (checkingRef.current) return;
      checkingRef.current = true;
      try {
        const fetched = await checkOtaUpdate();
        if (!cancelled && fetched) {
          otaReadyRef.current = true;   // staged → applies on next cold start regardless
          analytics.capture('aura_ota_ready', { viaPush });
          if (viaPush) setOtaReady(true);
        }
      } finally {
        checkingRef.current = false;
      }
    };

    (async () => {
      await runOta(false);                  // launch check — silent stage
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
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void runOta(false);   // foreground — silent stage
    });
    // Push-driven: a silent OTA-trigger message (server fires it after publish)
    // pulls the bundle immediately while the app is open — no polling, no
    // foreground bounce. Falls back to the launch/foreground checks above.
    const otaSub = DeviceEventEmitter.addListener(OTA_TRIGGER_EVENT, () => void runOta(true));
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

  // L1 (OTA / JS) reload prompt — only reached via the dev push-trigger
  // (otaReady is set only when viaPush). Offers an instant reload (no cold
  // start). Shown only when no native-update dialog is up (APK prompt takes
  // priority); dismissable, and it still applies on the next cold start anyway.
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
