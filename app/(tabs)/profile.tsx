import { Image, Pressable, Alert } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronRight } from 'lucide-react-native';
import { router, useFocusEffect } from 'expo-router';
import { useState, useCallback } from 'react';
import { getUserInfo, isLoggedIn, logout, type UserInfo } from '../../utils/auth';
import { colors } from '../../theme/colors';

export default function ProfileScreen() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);

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
    if (loggedIn) return;
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
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg.canvas }}>
      <YStack padding="$4" paddingBottom="$2">
        <Text fontSize={28} fontWeight="700" color={colors.text.primary}>我的</Text>
      </YStack>

      <Pressable onPress={handleUserCardPress}>
        <YStack
          backgroundColor={colors.bg.surface}
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
              <Text color={colors.text.primary} fontSize={18} fontWeight="600">
                {loggedIn ? (user?.nickname || '用户') : '未登录'}
              </Text>
              <Text color={colors.text.tertiary} fontSize={13} marginTop={2}>
                {loggedIn ? (user?.email || '') : '点击登录账号'}
              </Text>
            </YStack>
            {!loggedIn && <ChevronRight size={20} color={colors.text.faint} />}
          </XStack>
        </YStack>
      </Pressable>

      {loggedIn && (
        <Pressable onPress={handleLogout}>
          <YStack
            backgroundColor={colors.bg.surface}
            borderRadius="$3"
            marginHorizontal="$4"
            padding="$4"
            alignItems="center"
          >
            <Text color={colors.status.danger} fontSize={15}>退出登录</Text>
          </YStack>
        </Pressable>
      )}
    </SafeAreaView>
  );
}
