import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { TamaguiProvider, Theme } from 'tamagui';
import config from '../tamagui.config';

export default function RootLayout() {
  return (
    <TamaguiProvider config={config} defaultTheme="light">
      <Theme name="light">
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: '#f5f5f7' },
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="auth/login" options={{ headerShown: false }} />
          <Stack.Screen name="workshop/agent" options={{ headerShown: true, title: '智能体', headerStyle: { backgroundColor: '#ffffff' }, headerTintColor: '#1d1d1f' }} />
          <Stack.Screen name="workshop/pipeline" options={{ headerShown: true, title: '流水线', headerStyle: { backgroundColor: '#ffffff' }, headerTintColor: '#1d1d1f' }} />
          <Stack.Screen name="workshop/results" options={{ headerShown: true, title: '产出', headerStyle: { backgroundColor: '#ffffff' }, headerTintColor: '#1d1d1f' }} />
        </Stack>
      </Theme>
    </TamaguiProvider>
  );
}
