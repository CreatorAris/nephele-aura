import { Tabs, useRouter } from 'expo-router';
import { FloatingTabBar } from '../../components/FloatingTabBar';
import { TabIcon } from '../../components/TabIcon';
import { useEffect, useRef } from 'react';
import { BackHandler, ToastAndroid, Platform } from 'react-native';
import { useNavigation } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isLoggedIn, logout } from '../../utils/auth';
import { ONBOARDED_KEY } from '../onboarding';
import { remoteWS } from '../../utils/websocket';
import { initPush } from '../../utils/push';

export default function TabLayout() {
  const lastBack = useRef(0);
  const navigation = useNavigation();
  const router = useRouter();

  // Auth gate: on mount + on WS auth-invalid event, kick to login if the
  // stored token is missing or past its exp. Without this, an expired JWT
  // just looped reconnect forever and the user saw "桌面端未连接" with no
  // hint to re-login.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // First-run intro takes priority over the auth gate — show it once,
      // before login, on a fresh install.
      const onboarded = await AsyncStorage.getItem(ONBOARDED_KEY);
      if (!onboarded && !cancelled) { router.replace('/onboarding'); return; }
      const ok = await isLoggedIn();
      if (!ok && !cancelled) { router.replace('/auth/login'); return; }
      // Logged in (past onboarding/consent) → init push + register token.
      // No-op until the JPush native module + AppKey are built in (dormant).
      if (ok && !cancelled) void initPush();
    })();

    const unsub = remoteWS.onAuthInvalid(async () => {
      await logout();
      router.replace('/auth/login');
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [router]);

  // Double-press back to exit on tab screens
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // If navigation can go back (sub-page), let it handle normally
      if (navigation.canGoBack()) return false;

      const now = Date.now();
      if (now - lastBack.current < 2000) {
        BackHandler.exitApp();
        return true;
      }
      lastBack.current = now;
      ToastAndroid.show('再按一次退出', ToastAndroid.SHORT);
      return true; // prevent default exit
    });

    return () => sub.remove();
  }, [navigation]);

  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <FloatingTabBar {...props} />}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '素材库',
          // True line→fill swap on active (Remixicon, like tmui's selectedIcon).
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="gallery" color={color} size={size} filled={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="feed"
        options={{
          title: '订阅流',
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="rss" color={color} size={size} filled={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="remote"
        options={{
          title: '助手',
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="chat" color={color} size={size} filled={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="user" color={color} size={size} filled={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
