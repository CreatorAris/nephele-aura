import { useState, type ComponentProps } from 'react';
import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { XStack, Input } from 'tamagui';
import type { LucideIcon } from 'lucide-react-native';
import { colors } from '../theme/colors';

// Glass input — recessed violet gradient (sits "below" the card surface) +
// leading icon + brand-purple focus ring. Matches the glass card so fields
// don't read as flat plastic boxes.
type Props = {
  icon?: LucideIcon;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
} & Pick<ComponentProps<typeof Input>,
  'keyboardType' | 'autoCapitalize' | 'onSubmitEditing' | 'autoFocus' | 'maxLength' | 'secureTextEntry'>;

export function AuraInput({ icon: Icon, value, onChangeText, placeholder, ...rest }: Props) {
  const [focused, setFocused] = useState(false);
  return (
    <XStack height={52} borderRadius={14} overflow="hidden" alignItems="center"
      paddingHorizontal="$3.5" gap="$2.5" borderWidth={1}
      borderColor={focused ? colors.brand.primary : colors.border.default}>
      <LinearGradient colors={['#2A2546', '#221D3C']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill} />
      {Icon != null && <Icon size={19} color={colors.brand.primary} />}
      <Input flex={1} value={value} onChangeText={onChangeText} placeholder={placeholder}
        backgroundColor="transparent" borderWidth={0} color={colors.text.primary} fontSize={15}
        paddingHorizontal={0} placeholderTextColor={colors.text.muted}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        {...rest} />
    </XStack>
  );
}
