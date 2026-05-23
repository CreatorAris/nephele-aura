// Floating tab bar for Aura — matched to tmui x-tabbar's notched ("凸起") layout.
// tmui draws the bar on a <canvas> and cuts a concave notch with a mask, filled
// with a translucent / gradient color (NOT a live blur — its blur is a separate
// non-notched variant). We reproduce that faithfully with react-native-svg:
//   - one <Path> = rounded rect + concave semicircular notch at top-center,
//     filled with a vertical glass gradient + a rim stroke,
//   - a raised circular upload FAB nested in the notch,
//   - line→fill active icons (set in each screen's tabBarIcon).
// Dimensions follow tmui: bar 60, FAB 60, icon 28, notch radius ~37.
import { useEffect, useState, type ReactNode } from 'react';
import { View, Pressable, Text, StyleSheet, Platform } from 'react-native';
import Svg, { Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { LinearGradient as ExpoLinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { ImagePlus } from 'lucide-react-native';
import { colors } from '../theme/colors';
import { uploadBus } from '../utils/uploadBus';

export const TAB_BAR_HEIGHT = 54;   // mainstream mobile bar ~50-56 (was tmui's 60)
const SIDE_MARGIN = 16;
const BOTTOM_GAP = 10;
const BAR_RADIUS = 22;
const NOTCH_R = 33;        // scales with FAB → keeps even 7px gap
const FAB_SIZE = 52;       // ~mainstream center FAB (was tmui's 60)
// Raise so the FAB center sits exactly on the bar's top edge (y=0) — i.e.
// CONCENTRIC with the notch arc (whose center is also (cx, 0)). With FAB
// radius 30 inside notch radius 37 this leaves an even 7px gap all around.
const FAB_RAISE = FAB_SIZE / 2;

export const TAB_BAR_CLEARANCE = TAB_BAR_HEIGHT + BOTTOM_GAP + 18;
const POP = { damping: 12, stiffness: 220, mass: 0.6 };

// Rounded rect + concave semicircular notch dipping down at top-center.
function barPath(w: number, h: number, r: number, nr: number): string {
  const cx = w / 2;
  return [
    `M ${r} 0`,
    `L ${cx - nr} 0`,
    `A ${nr} ${nr} 0 0 0 ${cx + nr} 0`,   // notch (sweep 0 → dips downward into bar)
    `L ${w - r} 0`,
    `A ${r} ${r} 0 0 1 ${w} ${r}`,
    `L ${w} ${h - r}`,
    `A ${r} ${r} 0 0 1 ${w - r} ${h}`,
    `L ${r} ${h}`,
    `A ${r} ${r} 0 0 1 0 ${h - r}`,
    `L 0 ${r}`,
    `A ${r} ${r} 0 0 1 ${r} 0`,
    'Z',
  ].join(' ');
}

function TabItem({ focused, onPress, icon, label }: {
  focused: boolean; onPress: () => void; icon: ReactNode; label: string;
}) {
  const scale = useSharedValue(focused ? 1.1 : 1);
  useEffect(() => { scale.value = withSpring(focused ? 1.1 : 1, POP); }, [focused, scale]);
  const aStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Pressable style={styles.item} hitSlop={6} onPress={onPress}>
      <Animated.View style={[styles.itemInner, aStyle]}>
        {icon}
        <Text
          numberOfLines={1}
          style={[styles.label, {
            color: focused ? colors.brand.primary : colors.text.secondary,
            fontWeight: focused ? '600' : '500',
          }]}
        >
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

export function FloatingTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const [barW, setBarW] = useState(0);

  const tabs = state.routes.map((route, index) => {
    const { options } = descriptors[route.key];
    const focused = state.index === index;
    const label = (options.tabBarLabel ?? options.title ?? route.name) as string;
    const tint = focused ? colors.brand.primary : colors.text.secondary;
    const onPress = () => {
      const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
      if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
    };
    return (
      <TabItem key={route.key} focused={focused} onPress={onPress} label={label}
        icon={options.tabBarIcon?.({ focused, color: tint, size: 24 })} />
    );
  });
  const mid = Math.floor(tabs.length / 2);
  const slots = [...tabs.slice(0, mid), <View key="__notch" style={styles.item} pointerEvents="none" />, ...tabs.slice(mid)];

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + BOTTOM_GAP }]}>
      <View style={{ width: '100%', height: TAB_BAR_HEIGHT }} onLayout={(e) => setBarW(e.nativeEvent.layout.width)}>
        {barW > 0 && (
          <Svg width={barW} height={TAB_BAR_HEIGHT} style={StyleSheet.absoluteFill}>
            <Defs>
              <LinearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#3C365C" stopOpacity={0.82} />
                <Stop offset="1" stopColor="#262440" stopOpacity={0.9} />
              </LinearGradient>
            </Defs>
            <Path
              d={barPath(barW, TAB_BAR_HEIGHT, BAR_RADIUS, NOTCH_R)}
              fill="url(#glass)"
              stroke="rgba(130,120,160,0.35)"
              strokeWidth={1}
            />
          </Svg>
        )}
        <View style={styles.row}>{slots}</View>
      </View>

      {/* Raised upload FAB nested in the notch — gradient + rim gloss + glow
          for material depth (a flat solid fill read as a sticker). */}
      <Pressable
        onPress={() => { navigation.navigate(state.routes[0].name); uploadBus.trigger(); }}
        hitSlop={8}
        style={({ pressed }) => [styles.fabShadow, pressed && { transform: [{ scale: 0.94 }] }]}
      >
        <View style={styles.fabInner}>
          <ExpoLinearGradient
            colors={['#E8D2F2', '#CEACE0', '#B98FCE']}  // glossy top → brand → deeper bottom
            locations={[0, 0.55, 1]}
            start={{ x: 0.25, y: 0 }}
            end={{ x: 0.75, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <ImagePlus size={26} color={colors.bg.canvas} />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: SIDE_MARGIN, right: SIDE_MARGIN },
  row: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', alignItems: 'center' },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', height: '100%' },
  itemInner: { alignItems: 'center', justifyContent: 'center', gap: 3 },
  label: { fontSize: 11 },
  fabShadow: {
    position: 'absolute',
    left: '50%',
    marginLeft: -FAB_SIZE / 2,
    top: -FAB_RAISE,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    zIndex: 10,
    // soft brand-purple glow so it reads as a floating, lit orb
    ...Platform.select({
      ios: { shadowColor: colors.brand.primary, shadowOpacity: 0.7, shadowRadius: 16, shadowOffset: { width: 0, height: 5 } },
      android: { elevation: 18 },
    }),
  },
  fabInner: {
    flex: 1,
    borderRadius: FAB_SIZE / 2,
    overflow: 'hidden',                       // clip gradient to the circle
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',    // top-lit gloss rim
  },
});
