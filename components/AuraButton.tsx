import { Pressable, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { XStack, Text } from 'tamagui';
import type { LucideIcon } from 'lucide-react-native';
import { colors } from '../theme/colors';

// One tmui-aligned button for the whole app. tmui's x-button is a SOLID fill
// (gradient is opt-in, not default); its depth comes from a soft drop-shadow of
// its own colour, not a glossy gradient or a white rim. Skins:
//   primary — solid brand fill + soft brand-purple lift, dark text
//   thin    — soft brand tint fill, brand text
//   outline — hollow, brand-soft border, brand text
type Variant = 'primary' | 'thin' | 'outline';

export function AuraButton({
  label, onPress, variant = 'primary', icon: Icon, disabled = false, loading = false,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: LucideIcon;
  disabled?: boolean;
  loading?: boolean;
}) {
  const fg = variant === 'primary' ? colors.bg.canvas : colors.brand.primary;
  const dim = variant === 'primary' ? 0.88 : 0.55;
  const bg = variant === 'primary' ? colors.brand.primary
    : variant === 'thin' ? colors.brand.soft : 'transparent';
  return (
    <Pressable onPress={onPress} disabled={disabled || loading}
      style={({ pressed }) => ({ opacity: disabled ? 0.45 : pressed ? dim : 1 })}>
      <XStack height={52} borderRadius={14} alignItems="center" justifyContent="center" gap="$2"
        backgroundColor={bg}
        borderWidth={variant === 'outline' ? 1 : 0} borderColor={colors.brand.soft}
        style={variant === 'primary' ? styles.lift : undefined}>
        {loading ? (
          <ActivityIndicator color={fg} />
        ) : (
          <>
            {Icon != null && <Icon size={18} color={fg} />}
            <Text color={fg} fontWeight="600" fontSize={16}>{label}</Text>
          </>
        )}
      </XStack>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Soft brand-purple glow beneath the primary button — tmui's solid+shadow
  // depth (iOS coloured glow; Android falls back to elevation).
  lift: Platform.select({
    ios: { shadowColor: '#CEACE0', shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 5 } },
    android: { elevation: 8 },
  })!,
});
