import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { AuraDialog } from './AuraDialog';
import { colors } from '../theme/colors';
import {
  checkOtaUpdate,
  checkApkUpdate,
  downloadAndInstallApk,
  type AuraRelease,
} from '../utils/updater';
import analytics from '../utils/analytics';

// Invisible gate mounted at the app root. On launch it:
//   1. fetches an OTA bundle in the background (applies next cold start), then
//   2. checks for a newer APK and, if one exists, prompts the user.
// Mandatory updates suppress the cancel/scrim path so the app can't be used
// on a build that's been hard-cut.
type Phase = 'idle' | 'prompt' | 'downloading';

export function UpdateGate() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [release, setRelease] = useState<AuraRelease | null>(null);
  const [mandatory, setMandatory] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // L1 first — silent, never blocks. L2 prompt comes after.
      await checkOtaUpdate();
      const apk = await checkApkUpdate();
      if (cancelled || !apk) return;
      setRelease(apk.release);
      setMandatory(apk.mandatory);
      setPhase('prompt');
      analytics.capture('aura_update_prompt', {
        version: apk.release.version,
        mandatory: apk.mandatory,
      });
    })();
    return () => {
      cancelled = true;
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
