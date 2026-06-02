import { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { YStack, XStack, Text } from 'tamagui';
import { AuraButton } from '../components/AuraButton';
import { GlassCard } from '../components/GlassCard';
import { SafeAreaView } from 'react-native-safe-area-context';
import PagerView from 'react-native-pager-view';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Images, ImagePlus, QrCode,
  LayoutGrid, ZoomIn, Camera, ScanLine, Mail, Bot,
  type LucideIcon,
} from 'lucide-react-native';
import { colors } from '../theme/colors';
import analytics from '../utils/analytics';

export const ONBOARDED_KEY = 'aura_onboarded';

// First-run intro:
//   page 1 — welcome (names the app, says what it is)
//   page 2 — your library, on your phone (browse + import)
//   page 3 — pair with the desktop
// Borrows tmui's home aesthetic: per-slide accent, a tinted header band with a
// solid vivid icon block, and guidance rows that each carry their OWN icon
// (not a uniform checklist). Tints are opaque saturated colours, not alpha over
// the dark canvas (alpha tints read muddy). Headline/intro copy is functional
// placeholder, meant to be swapped for the brand voice later.
type Point = { icon: LucideIcon; text: string };
type Feature = {
  icon: LucideIcon; title: string; intro: string;
  accent: string; soft: string; points: Point[];
};
const FEATURES: Feature[] = [
  {
    icon: Images,
    title: '素材库随身',
    intro: '整个素材库装进口袋，随时翻看、随手添新',
    accent: colors.brand.primary,             // 紫
    soft: '#4A3580',                          // 不透明深紫 tint（保饱和，不发灰）
    points: [
      { icon: LayoutGrid, text: '瀑布流浏览整个素材库' },
      { icon: ZoomIn, text: '双指缩放看原图大图' },
      { icon: ImagePlus, text: '相册多选一键导入' },
      { icon: Camera, text: '拍照即存自动同步' },
    ],
  },
  {
    icon: QrCode,
    title: '连接你的桌面',
    intro: '和桌面 Nephele Workshop 配对，双向同步',
    accent: colors.brand.primary,             // 紫（与第二页统一）
    soft: '#4A3580',                          // 不透明深紫 tint
    points: [
      { icon: QrCode, text: '桌面端生成登录二维码' },
      { icon: ScanLine, text: '本页扫码对准即登录' },
      { icon: Mail, text: '也支持邮箱验证码登录' },
      { icon: Bot, text: '远程操控桌面 Agent' },
    ],
  },
];

const TOTAL = 1 + FEATURES.length;

export default function OnboardingScreen() {
  const pagerRef = useRef<PagerView>(null);
  const [page, setPage] = useState(0);
  const isLast = page === TOTAL - 1;

  // Funnel entry — paired with onboarding_page_viewed (per step) and
  // onboarding_finished (via skip/done) so first-run drop-off is visible.
  useEffect(() => { analytics.capture('onboarding_started', { total: TOTAL }); }, []);

  const finish = async (via: 'skip' | 'done') => {
    analytics.capture('onboarding_finished', { via, last_page: page, total: TOTAL });
    try { await AsyncStorage.setItem(ONBOARDED_KEY, '1'); } catch { /* non-fatal */ }
    router.replace('/auth/login');
  };
  const next = () => {
    if (isLast) finish('done');
    else pagerRef.current?.setPage(page + 1);
  };

  return (
    <SafeAreaView style={styles.container}>
      <XStack height={44} paddingHorizontal="$4" alignItems="center" justifyContent="flex-end">
        {!isLast && (
          <Text color={colors.text.tertiary} fontSize={14} pressStyle={{ opacity: 0.6 }} onPress={() => finish('skip')}>
            跳过
          </Text>
        )}
      </XStack>

      <PagerView
        ref={pagerRef}
        style={{ flex: 1 }}
        initialPage={0}
        onPageSelected={(e) => {
          const pos = e.nativeEvent.position;
          setPage(pos);
          if (pos > 0) analytics.capture('onboarding_page_viewed', { page: pos, total: TOTAL });
        }}
      >
        {/* Page 1 — welcome: name the app + say what it is. */}
        <YStack key="welcome" flex={1} alignItems="center" justifyContent="center" paddingHorizontal="$6" gap="$6">
          <Image source={require('../assets/icon.png')} style={styles.logo} contentFit="contain" />
          <YStack alignItems="center" gap={6}>
            <Text fontSize={28} fontWeight="800" color={colors.text.primary}>Nephele Aura</Text>
            <Text fontSize={14} fontWeight="500" color={colors.text.secondary}>为拒绝被替代的画师而造</Text>
          </YStack>
        </YStack>

        {/* Feature pages */}
        {FEATURES.map((s, i) => {
          const Icon = s.icon;
          return (
            <YStack key={i} flex={1} paddingHorizontal="$5" justifyContent="center">
              {/* tmui x-card pattern: glass card + header (icon + title + muted
                  subtitle) + content rows. No flat colored header band. */}
              <GlassCard style={{ gap: 18 }}>
                <XStack alignItems="center" gap="$3">
                  <YStack width={54} height={54} borderRadius={16} backgroundColor={s.accent}
                    alignItems="center" justifyContent="center">
                    <Icon size={27} color={colors.bg.canvas} />
                  </YStack>
                  <YStack flex={1} gap={3}>
                    <Text fontSize={20} fontWeight="700" color={colors.text.primary}>{s.title}</Text>
                    <Text fontSize={13} color={colors.text.secondary} lineHeight={18}>{s.intro}</Text>
                  </YStack>
                </XStack>

                <YStack height={1} backgroundColor="rgba(206,172,224,0.12)" />

                {/* Bare colored icons (tmui cell style), not filled chips —
                    lighter, airier; each icon distinct + accent-coloured. */}
                <YStack gap="$4">
                  {s.points.map((p, j) => {
                    const PIcon = p.icon;
                    return (
                      <XStack key={j} gap="$3" alignItems="center">
                        <PIcon size={20} color={s.accent} />
                        <Text flex={1} fontSize={14.5} color={colors.text.secondary} lineHeight={20}>
                          {p.text}
                        </Text>
                      </XStack>
                    );
                  })}
                </YStack>
              </GlassCard>
            </YStack>
          );
        })}
      </PagerView>

      <YStack paddingHorizontal="$5" paddingBottom="$6" gap="$5">
        <XStack alignSelf="center" gap={8} alignItems="center">
          {Array.from({ length: TOTAL }).map((_, i) => (
            <YStack key={i} height={8} width={i === page ? 22 : 8} borderRadius={4}
              backgroundColor={i === page ? colors.brand.primary : colors.border.default} />
          ))}
        </XStack>
        <AuraButton label={isLast ? '开始' : '下一步'} onPress={next} />
      </YStack>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.canvas },
  logo: { width: 88, height: 88, borderRadius: 22 },
});
