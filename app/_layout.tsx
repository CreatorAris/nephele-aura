import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { TamaguiProvider, Theme } from 'tamagui';
import config from '../tamagui.config';
import { Lightbox, LightboxProvider } from '../components/Lightbox';

export default function RootLayout() {
  return (
    // GestureHandlerRootView is required by react-native-gesture-handler at the
    // root of the app tree. The new Lightbox uses gesture-handler for
    // pinch/pan/dismiss; without this, gestures silently no-op on Android.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <TamaguiProvider config={config} defaultTheme="light">
        <Theme name="light">
          <StatusBar style="dark" />
          <LightboxProvider>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: '#fafafa' },
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="auth/login" options={{ headerShown: false }} />
            </Stack>
            {/* Lightbox overlays the entire app when activeLightbox != null. */}
            <Lightbox />
          </LightboxProvider>
        </Theme>
      </TamaguiProvider>
    </GestureHandlerRootView>
  );
}
