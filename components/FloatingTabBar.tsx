// Ported from tmui4x `x-tabbar` (uni-app) — specifically its "floating frosted
// pill" variant (the round=12 / backdrop / width≈90% example in the demo),
// adapted to React Native:
//   - Dropped its canvas notch/bulge center button: that design needs ~5 tabs
//     plus a central action, and Aura has 2 tabs (素材库 / 我的).
//   - lucide is monoline (no line→fill icon pair like remix-icon), so the
//     active state is a brand tint + a soft brand.soft highlight behind the
//     active item, instead of swapping to a filled icon.
// Numeric values mirror x-tabbar defaults: bar height 60, icon ~24-28,
// label 11px, items laid out space-around.
import { View, Pressable, Text, StyleSheet, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { colors } from '../theme/colors';

export const TAB_BAR_HEIGHT = 60;          // x-tabbar default height
const SIDE_MARGIN = 16;                    // x-tabbar floating width≈90% → side gutters
const BOTTOM_GAP = 10;                     // float above the gesture / nav area
const PILL_RADIUS = 24;                    // tmui used 12; bumped — a 60px-tall short bar reads as a pill at 24

// Content clearance so a screen's last items aren't hidden under the floating
// bar. Screens already sit inside a SafeAreaView (bottom inset consumed), so
// this is inset-independent: bar height + the gap + a little breathing room.
export const TAB_BAR_CLEARANCE = TAB_BAR_HEIGHT + BOTTOM_GAP + 18;

export function FloatingTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + BOTTOM_GAP }]}>
      <BlurView intensity={40} tint="dark" style={[styles.pill, { height: TAB_BAR_HEIGHT }]}>
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const focused = state.index === index;
          const label = (options.tabBarLabel ?? options.title ?? route.name) as string;
          // inactive uses text.secondary (not tertiary): tertiary at 11px is
          // sub-AA (~3.8:1) against the dark pill; secondary clears 4.5:1.
          const tint = focused ? colors.brand.primary : colors.text.secondary;

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress', target: route.key, canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
          };

          return (
            <Pressable key={route.key} onPress={onPress} style={styles.item} hitSlop={6}>
              <View style={styles.itemInner}>
                {options.tabBarIcon?.({ focused, color: tint, size: 24 })}
                <Text
                  numberOfLines={1}
                  style={[styles.label, { color: tint, fontWeight: focused ? '600' : '500' }]}
                >
                  {label}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: SIDE_MARGIN,
    right: SIDE_MARGIN,
  },
  pill: {
    flexDirection: 'row',
    justifyContent: 'space-around',        // x-tabbar .xTabbarWrap
    alignItems: 'center',
    borderRadius: PILL_RADIUS,
    overflow: 'hidden',                    // clip the blur to the rounded pill
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border.default,
    backgroundColor: 'rgba(46,42,72,0.62)',   // fallback under blur — bg.surface @ ~62% (Android blur is weak)
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } },
      android: { elevation: 12 },
    }),
  },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', height: '100%' },
  itemInner: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  label: { fontSize: 11 },                            // x-tabbar fontSize default
});
