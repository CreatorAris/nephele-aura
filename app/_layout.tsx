import { useEffect } from 'react';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { TamaguiProvider, Theme } from 'tamagui';
import config from '../tamagui.config';
import { Lightbox, LightboxProvider } from '../components/Lightbox';
import { UpdateGate } from '../components/UpdateGate';
import { SplashProvider } from '../components/AnimatedSplash';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { WebContainer } from '../components/WebContainer';
import analytics from '../utils/analytics';

export default function RootLayout() {
  // Initialize telemetry once for the app's lifetime (restores queue, starts
  // flush timer, tracks app lifecycle). Identity is attached later at login.
  useEffect(() => {
    void analytics.init();
    // Capture otherwise-invisible JS crashes through the same telemetry relay
    // (no extra SDK / public DSN in the open-source bundle). Native crashes
    // need a native module and are out of scope; this covers the JS-thread
    // majority, which is the bulk of RN crashes. The ErrorBoundary below
    // handles render-phase errors; this catches async / non-render ones.
    const eu = (globalThis as unknown as {
      ErrorUtils?: {
        getGlobalHandler?: () => ((e: Error, fatal?: boolean) => void) | undefined;
        setGlobalHandler?: (h: (e: Error, fatal?: boolean) => void) => void;
      };
    }).ErrorUtils;
    const prev = eu?.getGlobalHandler?.();
    eu?.setGlobalHandler?.((error, isFatal) => {
      try {
        analytics.capture('app_error', {
          fatal: !!isFatal,
          boundary: false,
          name: error?.name,
          message: String(error?.message ?? '').slice(0, 300),
          stack: String(error?.stack ?? '').slice(0, 1000),
        });
        void analytics.flush(); // best chance to send before a fatal tears us down
      } catch {
        // Crash reporting must never mask the original crash.
      }
      prev?.(error, isFatal);
    });
  }, []);

  // Emit a PostHog $screen event on every route change.
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) analytics.screen(pathname);
  }, [pathname]);

  return (
    // ErrorBoundary is the outermost wrapper so a render crash anywhere below —
    // including inside the providers — falls back gracefully and is reported.
    <ErrorBoundary>
    {/* GestureHandlerRootView is required by react-native-gesture-handler at the
        root of the app tree. The new Lightbox uses gesture-handler for
        pinch/pan/dismiss; without this, gestures silently no-op on Android. */}
    <GestureHandlerRootView style={{ flex: 1 }}>
      <TamaguiProvider config={config} defaultTheme="dark_nephele">
        <Theme name="dark_nephele">
          <StatusBar style="light" />
          {/* SplashProvider renders a branded overlay on the first frame to
              cover the cold-start gap, then fades out once the auth gate in
              (tabs)/_layout signals readiness. Keep it above the nav tree. */}
          <WebContainer>
          <SplashProvider>
            <LightboxProvider>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: '#1A1438' },
                }}
              >
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
                <Stack.Screen name="auth/login" options={{ headerShown: false }} />
                <Stack.Screen name="subscriptions" options={{ headerShown: false }} />
                <Stack.Screen name="diagnostics" options={{ headerShown: false }} />
                <Stack.Screen name="feedback" options={{ headerShown: false }} />
              </Stack>
              {/* Lightbox overlays the entire app when activeLightbox != null. */}
              <Lightbox />
              {/* OTA check + APK self-update prompt; renders nothing when idle. */}
              <UpdateGate />
            </LightboxProvider>
          </SplashProvider>
          </WebContainer>
        </Theme>
      </TamaguiProvider>
    </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
