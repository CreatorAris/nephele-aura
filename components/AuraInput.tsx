import { useState, type ComponentProps } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { XStack, Input } from 'tamagui';
import type { LucideIcon } from 'lucide-react-native';
import { colors } from '../theme/colors';

// Web-only: kill the browser focus outline the <input> draws over the field.
// Gated to web so the native build receives byte-identical props (no seesaw).
const webOutlineReset = Platform.OS === 'web'
  ? {
      outlineWidth: 0,
      outlineStyle: 'none' as const,
      outlineColor: 'transparent',
      focusStyle: { outlineWidth: 0, outlineColor: 'transparent', borderWidth: 0 },
    }
  : {};

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
    // Robust cross-browser layering: gradient fills the bottom layer, content
    // sits in an inner positioned container with zIndex 1 above it. No negative
    // zIndex (that was browser-fragile — it pushed the gradient behind the card
    // in some browsers, revealing a flat card-colored box).
    <XStack position="relative" height={52} borderRadius={14} overflow="hidden" borderWidth={1}
      borderColor={focused ? colors.brand.primary : colors.border.default}>
      <LinearGradient colors={['#2A2546', '#221D3C']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill} />
      <XStack position="relative" zIndex={1} flex={1} alignItems="center"
        paddingHorizontal="$3.5" gap="$2.5">
        {Icon != null && <Icon size={19} color={colors.brand.primary} />}
        {/* The brand-purple focus ring is the outer XStack border, driven by
            `focused`. webOutlineReset (web-only) removes the browser's own
            outline so it doesn't draw a nested box over the field. */}
        <Input flex={1} value={value} onChangeText={onChangeText} placeholder={placeholder}
          backgroundColor="transparent" borderWidth={0} color={colors.text.primary} fontSize={15}
          paddingHorizontal={0} placeholderTextColor={colors.text.muted}
          {...webOutlineReset}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          {...rest} />
      </XStack>
    </XStack>
  );
}
