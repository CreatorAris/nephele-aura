import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronLeft, RotateCw, MessageSquare, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react-native';
import { useRouter } from 'expo-router';

import { colors } from '../theme/colors';
import { GlassCard } from '../components/GlassCard';
import { AuraButton } from '../components/AuraButton';
import { runDiagnostics, type DiagItem, type DiagReport, type DiagStatus } from '../utils/diagnostics';
import analytics from '../utils/analytics';

// Self-check screen — the mobile counterpart of the desktop's diagnostics
// dialog. Runs runDiagnostics() on mount + on manual refresh, then renders each
// probe as a status row. The bottom CTA hands off to the feedback screen so a
// bug report can carry the snapshot (feedback re-collects it on its own toggle).
function statusVisual(status: DiagStatus) {
  switch (status) {
    case 'ok': return { color: colors.status.success, Icon: CheckCircle2 };
    case 'warn': return { color: colors.status.warning, Icon: AlertTriangle };
    default: return { color: colors.status.danger, Icon: XCircle };
  }
}

function DiagRow({ item, last }: { item: DiagItem; last: boolean }) {
  const { color, Icon } = statusVisual(item.status);
  return (
    <>
      <XStack paddingVertical={13} paddingHorizontal="$4" alignItems="center" gap={12}>
        <Icon size={20} color={color} />
        <YStack flexShrink={1} gap={2}>
          <Text color={colors.text.primary} fontSize={15}>{item.label}</Text>
          {item.hint ? (
            <Text color={color} fontSize={12}>{item.hint}</Text>
          ) : null}
        </YStack>
        {/* Full value, wraps to multiple lines — this is a debug surface, so
            never elide (was maxWidth+numberOfLines=1, which cut rtv/updateId). */}
        <Text color={colors.text.tertiary} fontSize={13} flex={1} textAlign="right">
          {item.detail}
        </Text>
      </XStack>
      {!last && <YStack height={1} backgroundColor="rgba(206,172,224,0.10)" marginLeft={48} />}
    </>
  );
}

export default function DiagnosticsScreen() {
  const router = useRouter();
  const [report, setReport] = useState<DiagReport | null>(null);
  const [loading, setLoading] = useState(true);

  const run = useCallback(async () => {
    setLoading(true);
    const r = await runDiagnostics();
    setReport(r);
    setLoading(false);
    analytics.capture('aura_self_check', {
      ok: r.summary.ok, warn: r.summary.warn, missing: r.summary.missing,
    });
  }, []);

  useEffect(() => { void run(); }, [run]);

  const headlineColor = report
    ? report.summary.missing ? colors.status.danger
      : report.summary.warn ? colors.status.warning
        : colors.status.success
    : colors.text.tertiary;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg.canvas }}>
      {/* Header — back + title + manual refresh */}
      <XStack alignItems="center" gap={6} paddingHorizontal={12} paddingVertical={10}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <ChevronLeft size={26} color={colors.text.primary} />
        </Pressable>
        <Text fontSize={18} fontWeight="700" color={colors.text.primary}>系统自检</Text>
        <YStack flex={1} />
        <Pressable onPress={() => { if (!loading) void run(); }} hitSlop={10} disabled={loading}>
          <RotateCw size={20} color={loading ? colors.text.faint : colors.brand.primary} />
        </Pressable>
      </XStack>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
        {/* Summary banner */}
        <GlassCard style={{ marginBottom: 14 }}>
          <YStack alignItems="center" paddingVertical={6} gap={6}>
            <Text fontSize={22} fontWeight="700" color={headlineColor}>
              {loading ? '检测中…' : report?.summary.headline ?? '—'}
            </Text>
            {report && !loading ? (
              <Text fontSize={13} color={colors.text.tertiary}>
                正常 {report.summary.ok} · 需注意 {report.summary.warn} · 缺失 {report.summary.missing}
              </Text>
            ) : null}
          </YStack>
        </GlassCard>

        {loading && !report ? (
          <YStack alignItems="center" paddingVertical={40}>
            <ActivityIndicator color={colors.brand.primary} />
          </YStack>
        ) : report ? (
          <GlassCard style={{ padding: 0, gap: 0 }}>
            {report.items.map((it, i) => (
              <DiagRow key={it.key} item={it} last={i === report.items.length - 1} />
            ))}
          </GlassCard>
        ) : null}

        {/* CTA — file a report. Feedback collects its own snapshot when the
            user enables the attach toggle there. */}
        <YStack marginTop={18}>
          <AuraButton label="反馈问题" variant="thin" icon={MessageSquare}
            onPress={() => router.push('/feedback')} />
        </YStack>
      </ScrollView>
    </SafeAreaView>
  );
}
