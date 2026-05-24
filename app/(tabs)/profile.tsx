import { Pressable } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronRight, Info, MonitorSmartphone, LogOut } from 'lucide-react-native';
import { router, useFocusEffect } from 'expo-router';
import { useState, useCallback, useEffect } from 'react';
import Constants from 'expo-constants';
import {
  getUserInfo, isLoggedIn, logout, getLicenseStatus,
  type UserInfo, type LicenseStatus,
} from '../../utils/auth';
import { remoteWS } from '../../utils/websocket';
import { colors } from '../../theme/colors';
import { GlassCard } from '../../components/GlassCard';
import { AuraDialog } from '../../components/AuraDialog';

function describeConnection(state: ReturnType<typeof remoteWS.getState>, desktopOnline: boolean) {
  if (state === 'connecting') return { label: '连接中', color: colors.status.warning };
  if (state === 'connected' && desktopOnline) return { label: '在线', color: colors.status.success };
  if (state === 'connected') return { label: '桌面端离线', color: colors.text.tertiary };
  return { label: '未连接', color: colors.text.tertiary };
}

// Tier label — mirrors gui/qml/components/LicenseCard.qml line 282-283 so
// Aura and the desktop Workshop show identical wording for the same backend
// state. Unrecognized paid tiers fall back to the raw string rather than
// being hidden — better to show "Custom" than to claim the user has no
// license when they do.
function formatTier(tier: string): string {
  switch (tier) {
    case 'founding': return '创始会员';
    case 'beta': return 'Beta';
    case 'release': return '正式版';
    case 'gift': return '赠送';
    default: return tier;
  }
}

// Expiry copy — mirrors LicenseCard.qml line 302-307. Uses the default
// system locale for the date portion (matches desktop's toLocaleDateString()
// without args) so user sees the same format they see on the desktop app.
function formatExpiry(iso?: string): string {
  if (!iso) return '';
  try {
    const exp = new Date(iso);
    const daysLeft = Math.ceil((exp.getTime() - Date.now()) / 86400000);
    if (daysLeft <= 0) return '已到期';
    if (daysLeft <= 7) return `剩余 ${daysLeft} 天`;
    return `到期 ${exp.toLocaleDateString()}`;
  } catch {
    return '';
  }
}

export default function ProfileScreen() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [licenseLoading, setLicenseLoading] = useState(false);
  const [wsState, setWsState] = useState(() => remoteWS.getState());
  const [desktopOnline, setDesktopOnline] = useState(() => remoteWS.getDesktopOnline());
  const [aboutVisible, setAboutVisible] = useState(false);
  const [logoutVisible, setLogoutVisible] = useState(false);
  const [transport, setTransport] = useState(() => remoteWS.getTransport());

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const li = await isLoggedIn();
        if (cancelled) return;
        setLoggedIn(li);
        if (li) {
          const info = await getUserInfo();
          if (!cancelled) setUser(info);
          setLicenseLoading(true);
          const status = await getLicenseStatus();
          if (!cancelled) {
            setLicense(status);
            setLicenseLoading(false);
          }
        } else {
          setUser(null);
          setLicense(null);
        }
      })();
      return () => { cancelled = true; };
    }, [])
  );

  useEffect(() => {
    const unsubState = remoteWS.onStateChange(setWsState);
    const unsubDesktop = remoteWS.onDesktopStateChange(setDesktopOnline);
    const unsubTransport = remoteWS.onTransportChange(setTransport);
    return () => { unsubState(); unsubDesktop(); unsubTransport(); };
  }, []);

  const handleHeroPress = () => {
    if (loggedIn) return;
    router.push('/auth/login');
  };

  const doLogout = async () => {
    await logout();
    setLoggedIn(false);
    setUser(null);
    setLicense(null);
  };


  const connection = describeConnection(wsState, desktopOnline);
  // Logical transport label (no hostnames) — tells the user how images flow.
  const transportLabel = transport === 'lan' ? '局域网直连' : transport === 'relay' ? '服务器中转' : '';
  const isPaid = !!license?.valid && license.tier !== 'free';
  // 云晶 is a unified, non-expiring pool — no cap, so no "/limit" or progress bar.
  const creditsRemaining = license?.credits_remaining ?? 0;
  const purchasedCredits = license?.purchased_credits ?? 0;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg.canvas }}>
      {/* Identity header — email only. Tier lives in the account card below,
          so we don't repeat it here as a pill. */}
      <Pressable onPress={handleHeroPress} disabled={loggedIn}>
        <YStack alignItems="center" paddingTop={40} paddingBottom={28} gap={10}>
          <Text color={colors.text.primary} fontSize={22} fontWeight="700">
            {loggedIn ? (user?.email || '用户') : '未登录'}
          </Text>
          {!loggedIn && (
            <Text color={colors.text.tertiary} fontSize={14}>点击登录账号</Text>
          )}
        </YStack>
      </Pressable>

      <YStack paddingHorizontal="$4" gap="$3.5">
        {/* Account — membership + 云晶 in one glass card. */}
        {loggedIn && (
          <GlassCard style={{ padding: 0, gap: 0 }}>
            <YStack paddingHorizontal="$4" paddingVertical="$3.5">
              <Text color={colors.text.tertiary} fontSize={12} marginBottom={6}>会员</Text>
              {licenseLoading && !license ? (
                <Text color={colors.text.tertiary} fontSize={16}>加载中…</Text>
              ) : isPaid ? (
                <XStack alignItems="baseline" gap={10}>
                  <Text color={colors.text.primary} fontSize={18} fontWeight="700">
                    {formatTier(license?.tier ?? '')}
                  </Text>
                  {license?.expires_at && (
                    <Text color={colors.text.tertiary} fontSize={13}>{formatExpiry(license.expires_at)}</Text>
                  )}
                </XStack>
              ) : (
                <Text color={colors.text.primary} fontSize={18} fontWeight="700">未激活</Text>
              )}
            </YStack>

            {isPaid && (
              <>
                <YStack height={1} backgroundColor="rgba(206,172,224,0.12)" />
                <YStack paddingHorizontal="$4" paddingVertical="$3.5">
                  <XStack alignItems="center" marginBottom={6}>
                    <Text flex={1} color={colors.text.tertiary} fontSize={12}>云晶</Text>
                    {purchasedCredits > 0 && (
                      <Text color={colors.text.tertiary} fontSize={12}>含已购 {purchasedCredits.toLocaleString()}</Text>
                    )}
                  </XStack>
                  <Text color={colors.text.primary} fontSize={30} fontWeight="700">
                    {creditsRemaining.toLocaleString()}
                  </Text>
                </YStack>
              </>
            )}
          </GlassCard>
        )}

        {/* Settings — tmui x-cell rows (bare colored icon + title + value/arrow) */}
        <GlassCard style={{ padding: 0, gap: 0 }}>
          <XStack paddingVertical={12} paddingHorizontal="$4" alignItems="center" gap={12}>
            <MonitorSmartphone size={20} color={colors.brand.primary} />
            <YStack flex={1} gap={2}>
              <Text color={colors.text.primary} fontSize={15}>桌面端</Text>
              {transportLabel ? (
                <Text color={colors.text.tertiary} fontSize={12}>{transportLabel}</Text>
              ) : null}
            </YStack>
            <Text color={connection.color} fontSize={13}>{connection.label}</Text>
            <YStack width={8} height={8} borderRadius={4} backgroundColor={connection.color} />
          </XStack>
          <YStack height={1} backgroundColor="rgba(206,172,224,0.10)" marginLeft={48} />
          <Pressable onPress={() => setAboutVisible(true)}>
            <XStack paddingVertical={14} paddingHorizontal="$4" alignItems="center" gap={12}>
              <Info size={20} color={colors.brand.primary} />
              <Text flex={1} color={colors.text.primary} fontSize={15}>关于</Text>
              <ChevronRight size={18} color={colors.text.faint} />
            </XStack>
          </Pressable>
        </GlassCard>

        {/* Logout — flows right after settings (NOT pinned to the screen bottom,
            so it can never collide with the floating tab bar / raised upload FAB). */}
        {loggedIn && (
          <Pressable onPress={() => setLogoutVisible(true)}>
            <GlassCard style={{ padding: 0 }}>
              <XStack paddingVertical={14} paddingHorizontal="$4" alignItems="center" justifyContent="center" gap={10}>
                <LogOut size={18} color={colors.status.danger} />
                <Text color={colors.status.danger} fontSize={15} fontWeight="600">退出登录</Text>
              </XStack>
            </GlassCard>
          </Pressable>
        )}
      </YStack>

      <AuraDialog visible={aboutVisible} title="Nephele Aura"
        onClose={() => setAboutVisible(false)} confirmLabel="好">
        <YStack alignItems="center" gap={12} paddingTop={2}>
          <Text fontSize={13} color={colors.text.tertiary}>
            版本 {Constants.expoConfig?.version ?? '1.0.0'}
          </Text>
          <Text fontSize={14} color={colors.text.secondary} textAlign="center" lineHeight={21}>
            画师的移动伴侣{'\n'}配合桌面端 Nephele Workshop
          </Text>
          <Text fontSize={12} color={colors.text.tertiary}>support@creatoraris.com · MIT 开源</Text>
        </YStack>
      </AuraDialog>
      <AuraDialog visible={logoutVisible} title="退出登录" message="确定要退出当前账号吗？"
        onClose={() => setLogoutVisible(false)} cancelLabel="取消" confirmLabel="退出" onConfirm={doLogout} danger />
    </SafeAreaView>
  );
}
