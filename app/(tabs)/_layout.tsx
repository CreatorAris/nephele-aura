import { Tabs } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useEffect, useRef, useCallback } from 'react';
import { BackHandler, ToastAndroid, Platform } from 'react-native';
import { useNavigation } from 'expo-router';

export default function TabLayout() {
  const lastBack = useRef(0);
  const navigation = useNavigation();

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
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#ffffff',
          borderTopColor: '#f0f0f0',
          borderTopWidth: 0.5,
          height: 56,
          paddingBottom: 4,
        },
        tabBarActiveTintColor: '#b388ff',
        tabBarInactiveTintColor: '#999999',
        tabBarLabelStyle: { fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '素材库',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="image-multiple" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="workshop"
        options={{
          title: '工坊',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="tools" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="account" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
