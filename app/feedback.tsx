import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, TextInput, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { ChevronLeft, Check } from 'lucide-react-native';
import { useRouter } from 'expo-router';

import { colors } from '../theme/colors';
import { GlassCard } from '../components/GlassCard';
import { AuraButton } from '../components/AuraButton';
import { AuraDialog } from '../components/AuraDialog';
import { isLoggedIn } from '../utils/auth';
import { submitFeedback } from '../utils/feedback';
import { runDiagnostics, type DiagReport } from '../utils/diagnostics';

// Feedback screen — mirrors the desktop FeedbackDialog (gui/qml/windows). Same
// categories (bug/suggestion/other, default bug) and the same attach-self-check
// toggle (default ON), pointed at the shared JWT-gated /v1/feedback route.
const CATEGORIES = [
  { key: 'bug', label: '问题' },
  { key: 'suggestion', label: '建议' },
  { key: 'other', label: '其他' },
] as const;

const MAX_BODY = 4000;

export default function FeedbackScreen() {
  const router = useRouter();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [category, setCategory] = useState<string>('bug');
  const [body, setBody] = useState('');
  const [focused, setFocused] = useState(false);
  const [attach, setAttach] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Self-check snapshot is collected lazily once (attach defaults ON, matching
  // desktop). Cached so toggling off/on doesn't re-run the network probes.
  const diagRef = useRef<DiagReport | null>(null);
  const captureDiag = useCallback(async () => {
    if (!diagRef.current) diagRef.current = await runDiagnostics();
  }, []);

  useEffect(() => {
    void isLoggedIn().then(setAuthed);
    void captureDiag(); // attach defaults ON → warm the snapshot up front
  }, [captureDiag]);

  const onAttachToggle = () => {
    const next = !attach;
    setAttach(next);
    if (next) void captureDiag();
  };

  const onSubmit = async () => {
    if (submitting || body.trim().length === 0) return;
    setSubmitting(true);
    const snapshot = attach ? (diagRef.current ?? (await runDiagnostics())) : null;
    const r = await submitFeedback(category, body, snapshot);
    setSubmitting(false);
    setResult({ ok: r.success, msg: r.message || (r.success ? '已收到，感谢反馈' : '提交失败') });
  };

  const onResultClose = () => {
    const wasOk = result?.ok;
    setResult(null);
    if (wasOk) router.back();
  };

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg.canvas }}>
      <XStack alignItems="center" gap={6} paddingHorizontal={12} paddingVertical={10}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <ChevronLeft size={26} color={colors.text.primary} />
        </Pressable>
        <Text fontSize={18} fontWeight="700" color={colors.text.primary}>意见反馈</Text>
      </XStack>

      {authed === null ? (
        <YStack flex={1} alignItems="center" justifyContent="center">
          <ActivityIndicator color={colors.brand.primary} />
        </YStack>
      ) : authed === false ? (
        <YStack flex={1} alignItems="center" justifyContent="center" paddingHorizontal={32} gap={16}>
          <Text fontSize={15} color={colors.text.tertiary} textAlign="center">
            登录后即可提交反馈
          </Text>
          <YStack width="100%">
            <AuraButton label="去登录" onPress={() => router.replace('/auth/login')} />
          </YStack>
        </YStack>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled">
          {/* Category chips */}
          <XStack gap={10} marginBottom={14}>
            {CATEGORIES.map((c) => {
              const sel = category === c.key;
              return (
                <Pressable key={c.key} onPress={() => setCategory(c.key)} style={{ flex: 1 }}>
                  <XStack height={40} borderRadius={12} alignItems="center" justifyContent="center"
                    backgroundColor={sel ? colors.brand.soft : 'transparent'}
                    borderWidth={1} borderColor={sel ? colors.brand.primary : colors.border.default}>
                    <Text fontSize={14} fontWeight={sel ? '600' : '500'}
                      color={sel ? colors.text.primary : colors.text.tertiary}>
                      {c.label}
                    </Text>
                  </XStack>
                </Pressable>
              );
            })}
          </XStack>

          {/* Body — multiline field, gradient recessed surface (mirrors AuraInput) */}
          <YStack borderRadius={14} overflow="hidden" borderWidth={1}
            borderColor={focused ? colors.brand.primary : colors.border.default} marginBottom={6}>
            <LinearGradient colors={['#2A2546', '#221D3C']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
              style={StyleSheet.absoluteFill} />
            <TextInput
              value={body}
              onChangeText={(t) => setBody(t.slice(0, MAX_BODY))}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="说说你遇到的问题或想法…（最多 4000 字）"
              placeholderTextColor={colors.text.muted}
              multiline
              textAlignVertical="top"
              style={{ color: colors.text.primary, fontSize: 15, minHeight: 150, maxHeight: 320,
                paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12 }}
            />
          </YStack>
          <Text fontSize={11} color={colors.text.faint} textAlign="right" marginBottom={14}>
            {body.length} / {MAX_BODY}
          </Text>

          {/* Attach self-check toggle (default ON, mirrors desktop) */}
          <Pressable onPress={onAttachToggle}>
            <XStack alignItems="center" gap={10} paddingVertical={4} marginBottom={20}>
              <XStack width={20} height={20} borderRadius={6} alignItems="center" justifyContent="center"
                backgroundColor={attach ? colors.brand.primary : 'transparent'}
                borderWidth={2} borderColor={attach ? colors.brand.primary : colors.border.default}>
                {attach && <Check size={13} color={colors.bg.canvas} strokeWidth={3} />}
              </XStack>
              <Text fontSize={13} color={attach ? colors.text.secondary : colors.text.tertiary} flex={1}>
                附带系统自检信息（已脱敏，帮助我们排查）
              </Text>
            </XStack>
          </Pressable>

          <AuraButton
            label={submitting ? '提交中…' : '提交'}
            onPress={onSubmit}
            loading={submitting}
            disabled={body.trim().length === 0}
          />
        </ScrollView>
      )}

      <AuraDialog
        visible={!!result}
        title={result?.ok ? '提交成功' : '提交未完成'}
        message={result?.msg ?? ''}
        confirmLabel="好"
        onClose={onResultClose}
      />
    </SafeAreaView>
  );
}
