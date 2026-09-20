import { Modal, Pressable, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { YStack, XStack, Text } from 'tamagui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LucideIcon } from 'lucide-react-native';
import { colors } from '../theme/colors';

// Branded bottom action sheet (replaces ugly native Alert action menus).
// tmui x-action-menu pattern: title + option rows in one glass panel, a
// separate "取消" panel below. Glass surface + brand-purple rim.
export type ActionOption = { label: string; icon?: LucideIcon; onPress: () => void; danger?: boolean };

export function AuraActionSheet({ visible, title, options, onClose }: {
  visible: boolean; title?: string; options: ActionOption[]; onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  // Close first, then run the action — opening a system picker while the modal
  // is still dismissing races on both platforms.
  const pick = (o: ActionOption) => { onClose(); setTimeout(o.onPress, 220); };

  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable
          // Phone-width and centered on wide windows (landscape / tablet).
          style={{ paddingHorizontal: 12, paddingBottom: insets.bottom + 12, width: '100%', maxWidth: 560, alignSelf: 'center' }}
          onPress={() => {}}
        >
          <LinearGradient colors={['#403979', '#332C5E']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.panel}>
            {title ? (
              <Text color={colors.text.tertiary} fontSize={13} textAlign="center" paddingVertical={12}>{title}</Text>
            ) : null}
            {options.map((o, i) => {
              const Icon = o.icon;
              return (
                <YStack key={i}>
                  {(i > 0 || title) ? <YStack height={1} backgroundColor="rgba(206,172,224,0.10)" /> : null}
                  <Pressable onPress={() => pick(o)} style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}>
                    <XStack height={50} alignItems="center" justifyContent="center" gap={10}>
                      {Icon != null && <Icon size={19} color={o.danger ? colors.status.danger : colors.brand.primary} />}
                      <Text fontSize={16} color={o.danger ? colors.status.danger : colors.text.primary}>{o.label}</Text>
                    </XStack>
                  </Pressable>
                </YStack>
              );
            })}
          </LinearGradient>

          <Pressable onPress={onClose} style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1, marginTop: 10 })}>
            <LinearGradient colors={['#403979', '#332C5E']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.cancel}>
              <Text fontSize={16} fontWeight="600" color={colors.text.secondary}>取消</Text>
            </LinearGradient>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  panel: {
    borderRadius: 20, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(206,172,224,0.30)',
  },
  cancel: {
    height: 54, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(206,172,224,0.30)',
  },
});
