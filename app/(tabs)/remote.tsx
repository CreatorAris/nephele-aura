import { YStack, Text } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Bot } from 'lucide-react-native';
import { colors } from '../../theme/colors';
import { TAB_BAR_CLEARANCE } from '../../components/FloatingTabBar';

// Placeholder — Agent 远控 (remote agent control). UI lands later.
export default function RemoteScreen() {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg.canvas }}>
      <YStack flex={1} justifyContent="center" alignItems="center" gap={14}
        paddingBottom={TAB_BAR_CLEARANCE}>
        <YStack width={72} height={72} borderRadius={36} backgroundColor={colors.bg.surface}
          justifyContent="center" alignItems="center">
          <Bot size={32} color={colors.brand.accent} />
        </YStack>
        <Text color={colors.text.primary} fontSize={17} fontWeight="600">Agent 远控</Text>
        <Text color={colors.text.tertiary} fontSize={13}>敬请期待</Text>
      </YStack>
    </SafeAreaView>
  );
}
