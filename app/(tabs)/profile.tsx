import { Pressable, Switch, Linking, AppState } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronRight, Info, MonitorSmartphone, LogOut, ChartNoAxesColumn, Bell, Wallet, RotateCw, Stethoscope, MessageSquare } from 'lucide-react-native';
import { router, useFocusEffect } from 'expo-router';
import { useState, useCallback, useEffect, useRef } from 'react';
import Constants from 'expo-constants';
import {
  getUserInfo, isLoggedIn, logout, getLicenseStatus,
  type UserInfo, type LicenseStatus,
} from '../../utils/auth';
import { getCatalog, createAlipayOrder, getPaymentStatus } from '../../utils/payment';
import { remoteWS } from '../../utils/websocket';
import { getPushConsent, setPushConsent } from '../../utils/push';
import analytics from '../../utils/analytics';
import { colors } from '../../theme/colors';
import { GlassCard } from '../../components/GlassCard';
import { AuraDialog } from '../../components/AuraDialog';
import { AuraActionSheet, type ActionOption } from '../../components/AuraActionSheet';

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
  const [analyticsEnabled, setAnalyticsEnabled] = useState(() => !analytics.isOptedOut());
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushConsentVisible, setPushConsentVisible] = useState(false);
  const pushDenyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rechargeVisible, setRechargeVisible] = useState(false);
  const [creditsOptions, setCreditsOptions] = useState<ActionOption[]>([]);
  const [paySuccessVisible, setPaySuccessVisible] = useState(false);
  const [payErrorMsg, setPayErrorMsg] = useState<string | null>(null);
  const [renewVisible, setRenewVisible] = useState(false);
  const [renewInfo, setRenewInfo] = useState<{ id: string; cents: number } | null>(null);
  const pendingOrderRef = useRef<string | null>(null);

  useEffect(() => {
    void getPushConsent().then((c) => setPushEnabled(c === 'granted'));
  }, []);

  // First-time enable from settings (consent never asked) routes through the
  // same opt-in dialog as the subscribe flow, so push is never turned on
  // without the explicit Huawei-compliant prompt. Already-decided users toggle
  // directly. AuraDialog fires onClose even on confirm (then onConfirm ~60ms
  // later) → the 150ms deny timer is cancelled by a confirm (mirrors subscriptions.tsx).
  const onPushToggle = async (v: boolean) => {
    if (v && (await getPushConsent()) === null) { setPushConsentVisible(true); return; }
    setPushEnabled(v);
    void setPushConsent(v);
  };
  const onPushConsentClose = () => {
    setPushConsentVisible(false);
    pushDenyTimer.current = setTimeout(() => { setPushEnabled(false); void setPushConsent(false); }, 150);
  };
  const onPushConsentConfirm = () => {
    if (pushDenyTimer.current) { clearTimeout(pushDenyTimer.current); pushDenyTimer.current = null; }
    setPushEnabled(true);
    void setPushConsent(true);
  };

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

  // ── H5 recharge (Alipay 手机网站支付 / WAP) ──────────────────────────────
  const pollPendingOrder = useCallback(async () => {
    const outTradeNo = pendingOrderRef.current;
    if (!outTradeNo) return;
    for (let i = 0; i < 5; i++) {
      const status = await getPaymentStatus(outTradeNo);
      if (status === 'paid') {
        pendingOrderRef.current = null;
        setLicense(await getLicenseStatus());
        setPaySuccessVisible(true);
        return;
      }
      if (status === 'failed' || status === 'not_found') {
        pendingOrderRef.current = null;
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    // Still pending after retries — keep the ref so the next foreground retries.
  }, []);

  // Alipay hands the user off to the system browser / Alipay app; reconcile the
  // order against the server when they return (app → active).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void pollPendingOrder();
    });
    return () => sub.remove();
  }, [pollPendingOrder]);

  const startPurchase = async (productId: string) => {
    const r = await createAlipayOrder(productId);
    if (!r.success || !r.payUrl) {
      setPayErrorMsg(r.message || '创建订单失败');
      return;
    }
    pendingOrderRef.current = r.outTradeNo ?? null;
    try {
      await Linking.openURL(r.payUrl);
    } catch {
      setPayErrorMsg('无法打开支付页面');
    }
  };

  // Credits-only top-up: license activation is intentionally NOT offered here —
  // picking the correct single license tier needs the desktop's channel +
  // default_product resolution; listing all visible license SKUs is what put
  // 正式版 next to beta. Mirrors desktop's _deriveCreditsTiers (kind === credits,
  // visible, ascending by credits_granted).
  const openRecharge = async () => {
    if (creditsOptions.length === 0) {
      const cat = await getCatalog();
      const tiers = Object.entries(cat?.products ?? {})
        .filter(([, p]) => p.kind === 'credits' && p.visible !== false)
        .sort((a, b) => (a[1].credits_granted ?? 0) - (b[1].credits_granted ?? 0));
      setCreditsOptions(
        tiers.map(([id, p]) => ({
          // catalog 的 display_price/name 当前是乱码,价格一律由 amount_cents 派生。
          label: `${(p.credits_granted ?? 0).toLocaleString()} 云晶 · ¥${(p.amount_cents / 100).toLocaleString()}`,
          onPress: () => { void startPurchase(id); },
        })),
      );
    }
    setRechargeVisible(true);
  };

  // 现价续费 = 当前在售 license 里价格最低的那档(beta/release 都 visible 时取 beta;
  // 转正后下架 beta 即自动落到 release)。所有人续到同一现价,不看持有档。后端按同一
  // create 路径延长有效期。
  const openRenewal = async () => {
    const cat = await getCatalog();
    const licenses = Object.entries(cat?.products ?? {})
      .filter(([, p]) => p.kind === 'license' && p.visible !== false)
      .sort((a, b) => a[1].amount_cents - b[1].amount_cents);
    const cheapest = licenses[0];
    if (!cheapest) { setPayErrorMsg('续费产品暂不可用'); return; }
    setRenewInfo({ id: cheapest[0], cents: cheapest[1].amount_cents });
    setRenewVisible(true);
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
            {/* 会员 — tier + expiry, with 续费 as an inline pill on the right
                (no longer a full row, so the card stays short). */}
            <YStack paddingHorizontal="$4" paddingVertical="$3.5">
              <Text color={colors.text.tertiary} fontSize={12} marginBottom={6}>会员</Text>
              <XStack alignItems="center" gap={10}>
                <YStack flex={1}>
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
                  <Pressable onPress={openRenewal} hitSlop={6}>
                    <XStack height={32} paddingHorizontal={14} borderRadius={16} alignItems="center" gap={5}
                      backgroundColor={colors.brand.soft}>
                      <RotateCw size={14} color={colors.brand.primary} />
                      <Text color={colors.brand.primary} fontSize={13} fontWeight="600">续费</Text>
                    </XStack>
                  </Pressable>
                )}
              </XStack>
            </YStack>

            {isPaid && (
              <>
                <YStack height={1} backgroundColor="rgba(206,172,224,0.12)" />
                {/* 云晶 — balance + 充值 as an inline pill on the right. */}
                <YStack paddingHorizontal="$4" paddingVertical="$3.5">
                  <XStack alignItems="center" marginBottom={6}>
                    <Text flex={1} color={colors.text.tertiary} fontSize={12}>云晶</Text>
                    {purchasedCredits > 0 && (
                      <Text color={colors.text.tertiary} fontSize={12}>含已购 {purchasedCredits.toLocaleString()}</Text>
                    )}
                  </XStack>
                  <XStack alignItems="center" gap={10}>
                    <Text flex={1} color={colors.text.primary} fontSize={30} fontWeight="700">
                      {creditsRemaining.toLocaleString()}
                    </Text>
                    <Pressable onPress={openRecharge} hitSlop={6}>
                      <XStack height={32} paddingHorizontal={14} borderRadius={16} alignItems="center" gap={5}
                        backgroundColor={colors.brand.soft}>
                        <Wallet size={14} color={colors.brand.primary} />
                        <Text color={colors.brand.primary} fontSize={13} fontWeight="600">充值</Text>
                      </XStack>
                    </Pressable>
                  </XStack>
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
          <XStack paddingVertical={12} paddingHorizontal="$4" alignItems="center" gap={12}>
            <ChartNoAxesColumn size={20} color={colors.brand.primary} />
            <YStack flex={1} gap={2}>
              <Text color={colors.text.primary} fontSize={15}>使用数据</Text>
              <Text color={colors.text.tertiary} fontSize={12}>匿名统计，帮助改进体验</Text>
            </YStack>
            <Switch
              value={analyticsEnabled}
              onValueChange={(v) => { setAnalyticsEnabled(v); void analytics.setOptOut(!v); }}
              trackColor={{ false: 'rgba(206,172,224,0.18)', true: colors.brand.primary }}
              thumbColor={colors.bg.canvas}
            />
          </XStack>
          <YStack height={1} backgroundColor="rgba(206,172,224,0.10)" marginLeft={48} />
          <XStack paddingVertical={12} paddingHorizontal="$4" alignItems="center" gap={12}>
            <Bell size={20} color={colors.brand.primary} />
            <YStack flex={1} gap={2}>
              <Text color={colors.text.primary} fontSize={15}>更新推送</Text>
              <Text color={colors.text.tertiary} fontSize={12}>关注的画师发新作品时通知你</Text>
            </YStack>
            <Switch
              value={pushEnabled}
              onValueChange={onPushToggle}
              trackColor={{ false: 'rgba(206,172,224,0.18)', true: colors.brand.primary }}
              thumbColor={colors.bg.canvas}
            />
          </XStack>
          <YStack height={1} backgroundColor="rgba(206,172,224,0.10)" marginLeft={48} />
          <Pressable onPress={() => router.push('/diagnostics')}>
            <XStack paddingVertical={14} paddingHorizontal="$4" alignItems="center" gap={12}>
              <Stethoscope size={20} color={colors.brand.primary} />
              <Text flex={1} color={colors.text.primary} fontSize={15}>系统自检</Text>
              <ChevronRight size={18} color={colors.text.faint} />
            </XStack>
          </Pressable>
          <YStack height={1} backgroundColor="rgba(206,172,224,0.10)" marginLeft={48} />
          <Pressable onPress={() => router.push('/feedback')}>
            <XStack paddingVertical={14} paddingHorizontal="$4" alignItems="center" gap={12}>
              <MessageSquare size={20} color={colors.brand.primary} />
              <Text flex={1} color={colors.text.primary} fontSize={15}>意见反馈</Text>
              <ChevronRight size={18} color={colors.text.faint} />
            </XStack>
          </Pressable>
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
      <AuraDialog
        visible={pushConsentVisible}
        title="开启更新推送?"
        message="关注的画师发布新作品时,第一时间通知你。可随时在设置里关闭。"
        cancelLabel="暂不"
        confirmLabel="开启推送"
        onClose={onPushConsentClose}
        onConfirm={onPushConsentConfirm}
      />
      <AuraActionSheet visible={rechargeVisible} title="云晶充值" options={creditsOptions}
        onClose={() => setRechargeVisible(false)} />
      <AuraDialog visible={renewVisible} title="续费"
        message={renewInfo ? `按现价 ¥${(renewInfo.cents / 100).toLocaleString()}/年续费,有效期顺延一年` : ''}
        cancelLabel="取消" confirmLabel="去支付"
        onClose={() => setRenewVisible(false)}
        onConfirm={() => { if (renewInfo) void startPurchase(renewInfo.id); }} />
      <AuraDialog visible={paySuccessVisible} title="支付成功" message="已到账,余额已刷新"
        onClose={() => setPaySuccessVisible(false)} confirmLabel="好" />
      <AuraDialog visible={!!payErrorMsg} title="支付未完成" message={payErrorMsg ?? ''}
        onClose={() => setPayErrorMsg(null)} confirmLabel="好" />
    </SafeAreaView>
  );
}
