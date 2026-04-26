import { View } from 'react-native';
import { YStack, XStack, Text, Separator } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useState, useCallback, useEffect } from 'react';
import { remoteWS } from '../../utils/websocket';
import { isLoggedIn } from '../../utils/auth';

const ACTIONS = [
  { key: 'agent', icon: 'message-text' as const, label: '智能体', route: '/workshop/agent' },
  { key: 'pipeline', icon: 'layers' as const, label: '流水线', route: '/workshop/pipeline' },
  { key: 'results', icon: 'image' as const, label: '产出', route: '/workshop/results' },
];

export default function WorkshopScreen() {
  const [connectionState, setConnectionState] = useState<string>('disconnected');
  const [credits, setCredits] = useState(50000);

  const connected = connectionState === 'connected';

  // Listen to WebSocket state
  useEffect(() => {
    const unsub = remoteWS.onStateChange(state => setConnectionState(state));
    return unsub;
  }, []);

  // Listen to status + credits updates from desktop
  useEffect(() => {
    const unsub = remoteWS.onMessage(msg => {
      if (!msg.data) return;
      // Initial status response
      if (msg.type === 'status') {
        if (typeof msg.data.credits === 'number') setCredits(msg.data.credits as number);
      }
      // Real-time credits updates (after each API call)
      if (msg.type === 'event' && msg.action === 'credits_updated') {
        if (typeof msg.data.credits === 'number') setCredits(msg.data.credits as number);
      }
    });
    return unsub;
  }, []);

  // Auto-connect when tab focused and logged in
  useFocusEffect(
    useCallback(() => {
      (async () => {
        if (await isLoggedIn()) {
          remoteWS.connect();
          // Request initial status
          setTimeout(() => remoteWS.requestStatus(), 500);
        }
      })();
    }, [])
  );

  const statusText = {
    disconnected: '桌面端离线',
    connecting: '正在连接...',
    connected: '桌面端在线',
  }[connectionState] || '桌面端离线';

  const statusColor = connected ? '#4ade80' : connectionState === 'connecting' ? '#F7B500' : '#dddddd';
  const statusTextColor = connected ? '#4ade80' : connectionState === 'connecting' ? '#F7B500' : '#999999';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#f5f5f7' }}>
      <YStack padding="$4" paddingBottom="$2">
        <Text fontSize={28} fontWeight="700" color="#1d1d1f">工坊</Text>
      </YStack>

      {/* Connection status */}
      <YStack
        backgroundColor="#ffffff"
        borderRadius="$3"
        marginHorizontal="$4"
        marginBottom="$4"
        padding="$4"
        borderWidth={1}
        borderColor="#f0f0f0"
      >
        <XStack alignItems="center" gap="$2">
          <View style={{
            width: 10, height: 10, borderRadius: 5,
            backgroundColor: statusColor,
          }} />
          <Text color={statusTextColor} fontSize={15} fontWeight="500">
            {statusText}
          </Text>
        </XStack>

        {connected && (
          <>
            <Separator marginVertical="$3" borderColor="#f0f0f0" />
            <XStack justifyContent="space-between" alignItems="center">
              <Text color="#999999" fontSize={13}>积分</Text>
              <Text color="#b388ff" fontSize={16} fontWeight="600">{credits.toLocaleString()}</Text>
            </XStack>
          </>
        )}
      </YStack>

      {/* Quick actions */}
      <XStack justifyContent="space-around" marginHorizontal="$4" marginBottom="$4" gap="$3">
        {ACTIONS.map(action => (
          <YStack
            key={action.key}
            flex={1}
            backgroundColor="#ffffff"
            borderRadius="$3"
            padding="$4"
            alignItems="center"
            gap="$2"
            pressStyle={{ opacity: 0.7 }}
            onPress={() => router.push(action.route)}
          >
            <MaterialCommunityIcons name={action.icon} size={28} color="#b388ff" />
            <Text color="#1d1d1f" fontSize={12}>{action.label}</Text>
          </YStack>
        ))}
      </XStack>

      {/* Recent activity */}
      <YStack paddingHorizontal="$4" flex={1}>
        <Text color="#1d1d1f" fontSize={16} fontWeight="600" marginBottom="$3">最近活动</Text>
        {!connected && (
          <YStack flex={1} justifyContent="center" alignItems="center">
            <Text color="#999999" fontSize={15}>等待连接桌面端</Text>
            <Text color="#bbbbbb" fontSize={13} marginTop="$1">请确保 Nephele 正在运行</Text>
          </YStack>
        )}
      </YStack>
    </SafeAreaView>
  );
}
