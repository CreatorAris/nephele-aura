import { Tabs, useRouter } from 'expo-router';
import { Images, User } from 'lucide-react-native';
import { FloatingTabBar } from '../../components/FloatingTabBar';
import { useEffect, useRef } from 'react';
import { BackHandler, ToastAndroid, Platform } from 'react-native';
import { useNavigation } from 'expo-router';
import { isLoggedIn, logout } from '../../utils/auth';
import { remoteWS } from '../../utils/websocket';

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
      const ok = await isLoggedIn();
      if (!ok && !cancelled) router.replace('/auth/login');
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
          tabBarIcon: ({ color, size }) => (
            <Images color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color, size }) => (
            <User color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
