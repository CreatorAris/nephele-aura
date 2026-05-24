import { Modal, Pressable, StyleSheet } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import type { ReactNode } from 'react';
import { GlassCard } from './GlassCard';
import { colors } from '../theme/colors';

// Branded centered dialog (replaces native Alert). iOS-alert footer: content,
// a full-width hairline, then LIGHT text buttons (single centered, or
// 取消 | 确定 split by a vertical hairline) — not heavy filled buttons.
//   Info:    <AuraDialog title message confirmLabel onClose />
//   Confirm: add cancelLabel + onConfirm (+ danger to redden the confirm)
//   Custom:  pass children instead of message
const RIM = 'rgba(206,172,224,0.16)';

export function AuraDialog({
  visible, title, message, children, onClose,
  confirmLabel = '好', onConfirm, cancelLabel, danger = false,
}: {
  visible: boolean;
  title: string;
  message?: string;
  children?: ReactNode;
  onClose: () => void;
  confirmLabel?: string;
  onConfirm?: () => void;
  cancelLabel?: string;
  danger?: boolean;
}) {
  const confirm = () => {
    onClose();
    if (onConfirm) {
      // Run after the dismiss animation; swallow async errors so a failing
      // confirm handler can't crash with an unhandled rejection.
      setTimeout(() => { Promise.resolve(onConfirm()).catch((e) => console.warn('[AuraDialog] confirm error', e)); }, 60);
    }
  };
  const confirmColor = danger ? colors.status.danger : colors.brand.primary;

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={styles.cardWrap} onPress={() => {}}>
          <GlassCard elevated style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
            <YStack paddingHorizontal={20} paddingTop={22} paddingBottom={18} gap={10}>
              <Text fontSize={17} fontWeight="700" color={colors.text.primary} textAlign="center">{title}</Text>
              {children ?? (message ? (
                <Text fontSize={14} color={colors.text.secondary} textAlign="center" lineHeight={21}>{message}</Text>
              ) : null)}
            </YStack>

            <YStack height={StyleSheet.hairlineWidth} backgroundColor={RIM} />

            {cancelLabel ? (
              <XStack>
                <Pressable style={({ pressed }) => [styles.btn, { opacity: pressed ? 0.5 : 1 }]} onPress={onClose}>
                  <Text fontSize={16} color={colors.text.secondary}>{cancelLabel}</Text>
                </Pressable>
                <YStack width={StyleSheet.hairlineWidth} backgroundColor={RIM} />
                <Pressable style={({ pressed }) => [styles.btn, { opacity: pressed ? 0.5 : 1 }]} onPress={confirm}>
                  <Text fontSize={16} fontWeight="600" color={confirmColor}>{confirmLabel}</Text>
                </Pressable>
              </XStack>
            ) : (
              <Pressable style={({ pressed }) => [styles.btn, { opacity: pressed ? 0.5 : 1 }]} onPress={confirm}>
                <Text fontSize={16} fontWeight="600" color={confirmColor}>{confirmLabel}</Text>
              </Pressable>
            )}
          </GlassCard>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36 },
  cardWrap: { width: '100%', maxWidth: 300 },
  btn: { flex: 1, height: 50, alignItems: 'center', justifyContent: 'center' },
});
