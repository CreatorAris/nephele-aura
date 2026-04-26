import { Image, Pressable, Alert } from 'react-native';
import { YStack, XStack, Text, Separator } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useState, useCallback } from 'react';
import { getUserInfo, isLoggedIn, logout, type UserInfo } from '../../utils/auth';

const MENU_ITEMS = [
  { key: 'works', icon: 'palette' as const, label: '我的作品' },
  { key: 'favorites', icon: 'heart' as const, label: '我的收藏' },
  { key: 'credits', icon: 'star-circle' as const, label: '积分中心' },
  { key: 'settings', icon: 'cog' as const, label: '设置' },
  { key: 'about', icon: 'information' as const, label: '关于' },
];

export default function ProfileScreen() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);

  // Refresh user info every time tab is focused
  useFocusEffect(
    useCallback(() => {
      (async () => {
        const li = await isLoggedIn();
        setLoggedIn(li);
        if (li) {
          const info = await getUserInfo();
          setUser(info);
        } else {
          setUser(null);
        }
      })();
    }, [])
  );

  const handleUserCardPress = () => {
    if (loggedIn) return; // already logged in, do nothing for now
    router.push('/auth/login');
  };

  const handleLogout = () => {
    Alert.alert('退出登录', '确定要退出登录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出',
        style: 'destructive',
        onPress: async () => {
          await logout();
          setLoggedIn(false);
          setUser(null);
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#f5f5f7' }}>
      <YStack padding="$4" paddingBottom="$2">
        <Text fontSize={28} fontWeight="700" color="#1d1d1f">我的</Text>
      </YStack>

      {/* User card */}
      <Pressable onPress={handleUserCardPress}>
        <YStack
          backgroundColor="#ffffff"
          borderRadius="$3"
          marginHorizontal="$4"
          marginBottom="$4"
          padding="$4"
        >
          <XStack alignItems="center" gap="$4">
            <Image
              source={require('../../assets/icon.png')}
              style={{ width: 56, height: 56, borderRadius: 28 }}
            />
            <YStack flex={1}>
              <Text color="#1d1d1f" fontSize={18} fontWeight="600">
                {loggedIn ? (user?.nickname || '用户') : '未登录'}
              </Text>
              <Text color="#999999" fontSize={13} marginTop={2}>
                {loggedIn ? (user?.email || '') : '点击登录账号'}
              </Text>
            </YStack>
            {!loggedIn && (
              <MaterialCommunityIcons name="chevron-right" size={20} color="#cccccc" />
            )}
          </XStack>

          <Separator marginVertical="$4" borderColor="#f0f0f0" />

          <XStack justifyContent="space-around">
            {[
              { value: '0', label: '作品' },
              { value: '0', label: '粉丝' },
              { value: '0', label: '关注' },
            ].map(stat => (
              <YStack key={stat.label} alignItems="center">
                <Text color="#1d1d1f" fontSize={20} fontWeight="700">{stat.value}</Text>
                <Text color="#999999" fontSize={12} marginTop={2}>{stat.label}</Text>
              </YStack>
            ))}
          </XStack>
        </YStack>
      </Pressable>

      {/* Menu */}
      <YStack
        backgroundColor="#ffffff"
        borderRadius="$3"
        marginHorizontal="$4"
        overflow="hidden"
      >
        {MENU_ITEMS.map((item, index) => (
          <Pressable key={item.key}>
            <XStack paddingVertical="$3" paddingHorizontal="$4" alignItems="center" gap="$3">
              <MaterialCommunityIcons name={item.icon} size={20} color="#b388ff" />
              <Text flex={1} color="#1d1d1f" fontSize={15}>{item.label}</Text>
              <MaterialCommunityIcons name="chevron-right" size={18} color="#cccccc" />
            </XStack>
            {index < MENU_ITEMS.length - 1 && (
              <Separator borderColor="#f5f5f5" marginLeft={52} />
            )}
          </Pressable>
        ))}
      </YStack>

      {/* Logout */}
      {loggedIn && (
        <Pressable onPress={handleLogout}>
          <YStack
            backgroundColor="#ffffff"
            borderRadius="$3"
            marginHorizontal="$4"
            marginTop="$4"
            padding="$4"
            alignItems="center"
          >
            <Text color="#FF383C" fontSize={15}>退出登录</Text>
          </YStack>
        </Pressable>
      )}
    </SafeAreaView>
  );
}
