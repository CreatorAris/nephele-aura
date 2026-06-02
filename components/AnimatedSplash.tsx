// Branded launch splash that covers the cold-start gap.
//
// Why this exists: the app has no native `expo-splash-screen` control, so the
// OS splash auto-hides the instant the JS bundle mounts — before the auth /
// onboarding gate in `(tabs)/_layout` resolves and before the first real
// screen paints. That left a black flash on every launch. This overlay paints
// on the very first JS frame (opacity 1, same canvas color as the native
// splash), so it catches the handoff seamlessly, then fades out once the app
// signals readiness via `useSplashReady().markReady()`.
//
// Pure JS (reanimated) — no native module, so it hot-reloads.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import * as NativeSplash from 'expo-splash-screen';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { colors } from '../theme/colors';

// Hold the OS splash open from the very first native frame so there's no
// black/blank gap before the JS bundle mounts. We hide it ourselves (below)
// only once our matching JS overlay has laid out, making the handoff seamless.
// Runs at module load — earliest possible point — and is safe to call twice.
NativeSplash.preventAutoHideAsync().catch(() => {});

// Keep the splash up for at least this long even if the app is ready instantly,
// so the brand moment reads as intentional rather than a flicker.
const MIN_DISPLAY_MS = 800;
// Safety net: if `markReady` is never called (e.g. the gate throws before its
// finally), force the splash away so the app is never stuck behind it.
const MAX_DISPLAY_MS = 4500;
const FADE_MS = 480;

type SplashCtx = { markReady: () => void };
const SplashContext = createContext<SplashCtx>({ markReady: () => {} });

/** Call inside the auth/onboarding gate to dismiss the splash once routing is decided. */
export function useSplashReady() {
  return useContext(SplashContext);
}

export function SplashProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(true);
  const mountedAt = useRef(Date.now());
  const dismissed = useRef(false);

  const opacity = useSharedValue(1);

  const beginFade = useCallback(() => {
    opacity.value = withTiming(0, { duration: FADE_MS, easing: Easing.out(Easing.cubic) }, (done) => {
      if (done) runOnJS(setVisible)(false);
    });
  }, [opacity]);

  const dismiss = useCallback(() => {
    if (dismissed.current) return;
    dismissed.current = true;
    const elapsed = Date.now() - mountedAt.current;
    const wait = Math.max(0, MIN_DISPLAY_MS - elapsed);
    setTimeout(beginFade, wait);
  }, [beginFade]);

  // Hard safety timeout so a thrown gate can't leave the splash up forever.
  useEffect(() => {
    const t = setTimeout(dismiss, MAX_DISPLAY_MS);
    return () => clearTimeout(t);
  }, [dismiss]);

  const containerStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <SplashContext.Provider value={{ markReady: dismiss }}>
      {children}
      {visible && (
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.container, containerStyle]}
          pointerEvents="none"
          // Our overlay is now laid out and painting on the same canvas color as
          // the native splash — hide the native one underneath for a seamless,
          // gap-free handoff.
          onLayout={() => { NativeSplash.hideAsync().catch(() => {}); }}
        >
          <SplashContent />
        </Animated.View>
      )}
    </SplashContext.Provider>
  );
}

function SplashContent() {
  const logoScale = useSharedValue(0.9);
  const logoOpacity = useSharedValue(0);
  const glow = useSharedValue(0.96);
  const wordmarkOpacity = useSharedValue(0);

  useEffect(() => {
    logoOpacity.value = withTiming(1, { duration: 420, easing: Easing.out(Easing.cubic) });
    logoScale.value = withSpring(1, { damping: 15, stiffness: 120, mass: 0.9 });
    wordmarkOpacity.value = withSequence(
      withTiming(0, { duration: 220 }),
      withTiming(1, { duration: 460, easing: Easing.out(Easing.cubic) }),
    );
    // Slow breathing halo behind the icon.
    glow.value = withRepeat(
      withTiming(1.08, { duration: 2200, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(logoScale);
      cancelAnimation(logoOpacity);
      cancelAnimation(glow);
      cancelAnimation(wordmarkOpacity);
    };
  }, [logoScale, logoOpacity, glow, wordmarkOpacity]);

  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: glow.value }],
  }));
  const wordmarkStyle = useAnimatedStyle(() => ({ opacity: wordmarkOpacity.value }));

  return (
    <View style={styles.center}>
      <View style={styles.logoWrap}>
        <Animated.View style={[styles.glow, glowStyle]} pointerEvents="none">
          <Svg width={GLOW} height={GLOW}>
            <Defs>
              <RadialGradient id="halo" cx="50%" cy="50%" r="50%">
                <Stop offset="0%" stopColor={colors.brand.primary} stopOpacity="0.5" />
                <Stop offset="42%" stopColor={colors.brand.primary} stopOpacity="0.16" />
                <Stop offset="100%" stopColor={colors.brand.primary} stopOpacity="0" />
              </RadialGradient>
            </Defs>
            <Rect width={GLOW} height={GLOW} fill="url(#halo)" />
          </Svg>
        </Animated.View>
        <Animated.View style={logoStyle}>
          <Image source={require('../assets/splash-icon.png')} style={styles.logo} />
        </Animated.View>
      </View>
      <Animated.Text style={[styles.wordmark, wordmarkStyle]}>Nephele</Animated.Text>
    </View>
  );
}

const LOGO = 132;
const GLOW = 300;
const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bg.canvas,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  center: { alignItems: 'center', justifyContent: 'center' },
  logoWrap: { width: LOGO, height: LOGO, alignItems: 'center', justifyContent: 'center' },
  glow: {
    position: 'absolute',
    width: GLOW,
    height: GLOW,
    top: (LOGO - GLOW) / 2,
    left: (LOGO - GLOW) / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: { width: LOGO, height: LOGO },
  wordmark: {
    marginTop: 30,
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: 5,
    color: colors.text.primary,
  },
});
