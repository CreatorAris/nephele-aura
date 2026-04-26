import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withDelay,
  interpolate,
} from 'react-native-reanimated';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { YStack, Text } from 'tamagui';

type Props = {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  title: string;
  subtitle?: string;
};

export default function EmptyState({ icon, title, subtitle }: Props) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(200, withSpring(1, { damping: 18, stiffness: 180 }));
  }, []);

  const iconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0, 1]),
    transform: [
      { scale: interpolate(progress.value, [0, 1], [0.6, 1]) },
    ],
  }));

  const textStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.5, 1], [0, 0, 1]),
    transform: [
      { translateY: interpolate(progress.value, [0, 1], [10, 0]) },
    ],
  }));

  return (
    <YStack flex={1} justifyContent="center" alignItems="center" gap="$3">
      <Animated.View style={[styles.iconWrap, iconStyle]}>
        <MaterialCommunityIcons name={icon} size={36} color="#d4c4f0" />
      </Animated.View>
      <Animated.View style={textStyle}>
        <Text color="#999999" fontSize={16} textAlign="center">{title}</Text>
        {subtitle && (
          <Text color="#bbbbbb" fontSize={13} textAlign="center" marginTop="$1" lineHeight={20}>
            {subtitle}
          </Text>
        )}
      </Animated.View>
    </YStack>
  );
}

const styles = StyleSheet.create({
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#f8f0ff',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
