import { Pressable, Alert } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronRight, Info } from 'lucide-react-native';
import { router, useFocusEffect } from 'expo-router';
import { useState, useCallback, useEffect } from 'react';
import Constants from 'expo-constants';
import {
  getUserInfo, isLoggedIn, logout, getLicenseStatus,
  type UserInfo, type LicenseStatus,
} from '../../utils/auth';
import { remoteWS } from '../../utils/websocket';
import { colors } from '../../theme/colors';
import { TAB_BAR_CLEARANCE } from '../../components/FloatingTabBar';

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
    return () => { unsubState(); unsubDesktop(); };
  }, []);

  const handleHeroPress = () => {
    if (loggedIn) return;
    router.push('/auth/login');
  };

  const handleLogout = () => {
    Alert.alert('退出登录', '确定要退出登录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出',
        style: 'destructive',
        onPress: async () => {
          await logout();
          setLoggedIn(false);
          setUser(null);
          setLicense(null);
        },
      },
    ]);
  };

  const showAbout = () => {
    const version = Constants.expoConfig?.version ?? '1.0.0';
    Alert.alert(
      'Nephele Aura',
      `版本 ${version}\n\n画师的移动伴侣\n配合桌面端 Nephele Workshop\n\n反馈：support@creatoraris.com\nMIT 开源`,
      [{ text: '好' }],
    );
  };

  const connection = describeConnection(wsState, desktopOnline);
  const isPaid = !!license?.valid && license.tier !== 'free';
  const creditsRemaining = license?.credits_remaining ?? 0;
  const creditsLimit = license?.credits_limit ?? 50000;
  const purchasedCredits = license?.purchased_credits ?? 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg.canvas }}>
      {/* Identity hero — email-only. Nickname is a system fallback
          (email.split('@')[0]) not a user-set label, so showing it would
          be the same kind of lie as showing the app icon as an avatar. */}
      <Pressable onPress={handleHeroPress} disabled={loggedIn}>
        <YStack alignItems="center" paddingTop={48} paddingHorizontal="$4" paddingBottom={8}>
          <Text color={colors.text.primary} fontSize={22} fontWeight="600">
            {loggedIn ? (user?.email || '用户') : '未登录'}
          </Text>
          {!loggedIn && (
            <Text color={colors.text.tertiary} fontSize={14} marginTop={6}>
              点击登录账号
            </Text>
          )}
        </YStack>
      </Pressable>

      <YStack height={32} />

      {/* Account card — membership + Nepheline live together as a single
          "account state" surface, separated by a hairline so each section
          keeps a clear label without inflating into two same-sized cards
          (which made the screen read as a flat list with no hierarchy). */}
      {loggedIn && (
        <YStack
          backgroundColor={colors.bg.surface}
          borderRadius="$3"
          marginHorizontal="$4"
          marginBottom="$4"
          paddingHorizontal="$4"
        >
          {/* Membership section */}
          <YStack paddingTop="$3" paddingBottom={isPaid ? "$3" : "$3"}>
            <Text color={colors.text.tertiary} fontSize={12} marginBottom={6}>会员</Text>
            {licenseLoading && !license ? (
              <Text color={colors.text.tertiary} fontSize={15}>加载中…</Text>
            ) : isPaid ? (
              <XStack alignItems="baseline" gap={10}>
                <Text color={colors.text.primary} fontSize={17} fontWeight="600">
                  {formatTier(license?.tier ?? '')}
                </Text>
                {license?.expires_at && (
                  <Text color={colors.text.tertiary} fontSize={13}>
                    {formatExpiry(license.expires_at)}
                  </Text>
                )}
              </XStack>
            ) : (
              <Text color={colors.text.primary} fontSize={17} fontWeight="600">未激活</Text>
            )}
          </YStack>

          {/* Hairline divider — only when there's a Nepheline section below */}
          {isPaid && (
            <YStack height={1} backgroundColor={colors.border.hairline} />
          )}

          {/* Nepheline (云晶) section */}
          {isPaid && (
            <YStack paddingTop="$3" paddingBottom="$3">
              <Text color={colors.text.tertiary} fontSize={12} marginBottom={6}>云晶</Text>
              <XStack alignItems="baseline" gap={6}>
                <Text color={colors.text.primary} fontSize={26} fontWeight="600">
                  {creditsRemaining.toLocaleString()}
                </Text>
                <Text color={colors.text.tertiary} fontSize={13}>
                  / {creditsLimit.toLocaleString()}
                </Text>
                {purchasedCredits > 0 && (
                  <Text color={colors.text.tertiary} fontSize={13} marginLeft="auto">
                    + {purchasedCredits.toLocaleString()} 已购
                  </Text>
                )}
              </XStack>
            </YStack>
          )}
        </YStack>
      )}

      {/* Settings card — runtime status + entry rows. One card with hairline
          divider mirrors iOS Settings' grouping pattern. */}
      <YStack
        backgroundColor={colors.bg.surface}
        borderRadius="$3"
        marginHorizontal="$4"
        overflow="hidden"
      >
        <XStack paddingVertical="$3" paddingHorizontal="$4" alignItems="center" gap={12}>
          <YStack width={8} height={8} borderRadius={4} backgroundColor={connection.color} />
          <Text flex={1} color={colors.text.primary} fontSize={15}>桌面端 · {connection.label}</Text>
        </XStack>
        <YStack height={1} backgroundColor={colors.border.hairline} marginLeft={44} />
        <Pressable onPress={showAbout}>
          <XStack paddingVertical="$3" paddingHorizontal="$4" alignItems="center" gap={12}>
            <Info size={18} color={colors.brand.primary} />
            <Text flex={1} color={colors.text.primary} fontSize={15}>关于</Text>
            <ChevronRight size={18} color={colors.text.faint} />
          </XStack>
        </Pressable>
      </YStack>

      <YStack flex={1} />

      {loggedIn && (
        <Pressable onPress={handleLogout}>
          <YStack
            backgroundColor={colors.bg.surface}
            borderRadius="$3"
            marginHorizontal="$4"
            marginBottom={TAB_BAR_CLEARANCE}
            padding="$4"
            alignItems="center"
          >
            <Text color={colors.status.danger} fontSize={15}>退出登录</Text>
          </YStack>
        </Pressable>
      )}
    </SafeAreaView>
  );
}
