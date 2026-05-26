import { useEffect } from 'react';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { TamaguiProvider, Theme } from 'tamagui';
import config from '../tamagui.config';
import { Lightbox, LightboxProvider } from '../components/Lightbox';
import { UpdateGate } from '../components/UpdateGate';
import analytics from '../utils/analytics';

export default function RootLayout() {
  // Initialize telemetry once for the app's lifetime (restores queue, starts
  // flush timer, tracks app lifecycle). Identity is attached later at login.
  useEffect(() => { void analytics.init(); }, []);

  // Emit a PostHog $screen event on every route change.
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) analytics.screen(pathname);
  }, [pathname]);

  return (
    // GestureHandlerRootView is required by react-native-gesture-handler at the
    // root of the app tree. The new Lightbox uses gesture-handler for
    // pinch/pan/dismiss; without this, gestures silently no-op on Android.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <TamaguiProvider config={config} defaultTheme="dark_nephele">
        <Theme name="dark_nephele">
          <StatusBar style="light" />
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
            </Stack>
            {/* Lightbox overlays the entire app when activeLightbox != null. */}
            <Lightbox />
            {/* OTA check + APK self-update prompt; renders nothing when idle. */}
            <UpdateGate />
          </LightboxProvider>
        </Theme>
      </TamaguiProvider>
    </GestureHandlerRootView>
  );
}
