import { YStack, Text } from 'tamagui';
import { MaterialCommunityIcons } from '@expo/vector-icons';

export default function ResultsScreen() {
  return (
    <YStack flex={1} backgroundColor="#f5f5f7" justifyContent="center" alignItems="center" gap="$3">
      <YStack
        width={80} height={80} borderRadius={40}
        backgroundColor="#f0f0f0" justifyContent="center" alignItems="center"
      >
        <MaterialCommunityIcons name="package-variant" size={36} color="#cccccc" />
      </YStack>
      <Text color="#999999" fontSize={16}>暂无产出</Text>
      <Text color="#bbbbbb" fontSize={13}>流水线的输出结果将显示在这里</Text>
    </YStack>
  );
}
