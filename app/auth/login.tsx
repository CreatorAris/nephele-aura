import { StyleSheet, Keyboard, Platform, TextInput, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { YStack, XStack, Text } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState, useEffect, useRef } from 'react';
import { router } from 'expo-router';
import { Mail, ScanLine } from 'lucide-react-native';
import { sendCode, verifyCode } from '../../utils/auth';
import { AuraButton } from '../../components/AuraButton';
import { AuraInput } from '../../components/AuraInput';
import { GlassCard } from '../../components/GlassCard';
import { colors } from '../../theme/colors';

type Step = 'email' | 'code';
const CODE_LEN = 6;

// Segmented verification-code input (tmui x-code-input pattern): a row of boxes
// over one hidden TextInput. The box at the caret position gets a brand border.
function CodeBoxes({ value, onChange, onComplete }: {
  value: string; onChange: (v: string) => void; onComplete: (v: string) => void;
}) {
  const ref = useRef<TextInput>(null);
  return (
    <Pressable onPress={() => ref.current?.focus()}>
      <XStack gap="$2.5" justifyContent="center">
        {Array.from({ length: CODE_LEN }).map((_, i) => {
          const char = value[i] ?? '';
          const active = i === value.length || (value.length === CODE_LEN && i === CODE_LEN - 1);
          return (
            <YStack key={i} width={46} height={56} borderRadius={14}
              borderWidth={1.5} borderColor={active ? colors.brand.primary : colors.border.default}
              backgroundColor={colors.bg.subtle} alignItems="center" justifyContent="center">
              <Text fontSize={22} fontWeight="700" color={colors.text.primary}>{char}</Text>
            </YStack>
          );
        })}
      </XStack>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={(t) => {
          const v = t.replace(/\D/g, '').slice(0, CODE_LEN);
          onChange(v);
          if (v.length === CODE_LEN) onComplete(v);
        }}
        keyboardType="number-pad"
        maxLength={CODE_LEN}
        autoFocus
        caretHidden
        // Glyphs + caret invisible — the boxes render the value, not this input.
        style={[StyleSheet.absoluteFill, { color: 'transparent' }]}
      />
    </Pressable>
  );
}

export default function LoginScreen() {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [kbHeight, setKbHeight] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Edge-to-edge (Expo SDK 54) stops the window from resizing for the IME, so a
  // platform-branched KeyboardAvoidingView leaves the centered form behind the
  // keyboard on Android. Pad the container by the real IME height instead —
  // justifyContent:center re-centers the form into the remaining space.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    if (countdown > 0) {
      timerRef.current = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) { if (timerRef.current) clearInterval(timerRef.current); return 0; }
          return prev - 1;
        });
      }, 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [countdown]);

  const handleSendCode = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('请输入有效的邮箱地址');
      return;
    }
    setError('');
    setLoading(true);
    const result = await sendCode(trimmed);
    setLoading(false);
    if (result.success) {
      setStep('code');
      setCode('');
      setCountdown(60);
    } else {
      setError(result.message);
      if (result.retryAfter) setCountdown(result.retryAfter);
    }
  };

  const handleVerifyCode = async (value?: string) => {
    const c = (value ?? code).trim();
    if (c.length < CODE_LEN) { setError('请输入完整的验证码'); return; }
    setError('');
    setLoading(true);
    const result = await verifyCode(email.trim().toLowerCase(), c);
    setLoading(false);
    if (result.success) router.replace('/(tabs)');
    else { setError(result.message); setCode(''); }
  };

  return (
    <SafeAreaView style={styles.container}>
        <YStack flex={1} justifyContent="center" paddingHorizontal="$5" gap="$5" paddingBottom={kbHeight}>
          {/* Login card — brand + form contained in one padded card. tmui's
              login wraps the whole form in an x-sheet (centered, big padding),
              not full-bleed bars stacked down the page. */}
          <GlassCard style={{ paddingHorizontal: 20, paddingVertical: 26, gap: 20 }}>
            <YStack alignItems="center" gap="$3">
              <Image source={require('../../assets/icon.png')} style={styles.logo} contentFit="contain" />
              {/* tmui title/subtitle pairing: bold dominant title + small muted
                  supporting line, tight together. */}
              <YStack alignItems="center" gap={5}>
                <Text fontSize={26} fontWeight="800" color={colors.text.primary}>Nephele Aura</Text>
                <Text fontSize={13} fontWeight="500" color={colors.text.secondary}>为拒绝被替代的画师而造</Text>
              </YStack>
            </YStack>

            {step === 'email' ? (
              <YStack gap="$3.5">
                <AuraInput icon={Mail} placeholder="请输入邮箱" value={email} onChangeText={setEmail}
                  keyboardType="email-address" autoCapitalize="none" onSubmitEditing={handleSendCode} />
                {error !== '' && <Text color={colors.status.error} fontSize={13} textAlign="center">{error}</Text>}
                <AuraButton label="获取验证码" onPress={handleSendCode} loading={loading} />
              </YStack>
            ) : (
              <YStack gap="$3.5">
                <Text color={colors.text.secondary} fontSize={13.5} textAlign="center">
                  验证码已发送至 {email}
                </Text>
                <CodeBoxes value={code} onChange={setCode} onComplete={(v) => handleVerifyCode(v)} />
                {error !== '' && <Text color={colors.status.error} fontSize={13} textAlign="center">{error}</Text>}
                <AuraButton label="登录" onPress={() => handleVerifyCode()} loading={loading} />
                <XStack justifyContent="center" gap="$5">
                  <Text color={countdown > 0 ? colors.text.muted : colors.brand.primary} fontSize={13}
                    pressStyle={{ opacity: 0.6 }} onPress={countdown > 0 ? undefined : handleSendCode}>
                    {countdown > 0 ? `${countdown}s 后重发` : '重新发送'}
                  </Text>
                  <Text color={colors.text.tertiary} fontSize={13} pressStyle={{ opacity: 0.6 }}
                    onPress={() => { setStep('email'); setCode(''); setError(''); }}>
                    更换邮箱
                  </Text>
                </XStack>
              </YStack>
            )}
          </GlassCard>

          {/* Scan — secondary card below, separated by 或 */}
          {step === 'email' && (
            <YStack gap="$4">
              <XStack alignItems="center" gap="$3">
                <YStack flex={1} height={1} backgroundColor={colors.border.hairline} />
                <Text color={colors.text.muted} fontSize={12}>或</Text>
                <YStack flex={1} height={1} backgroundColor={colors.border.hairline} />
              </XStack>
              <AuraButton variant="outline" icon={ScanLine} label="扫码登录桌面"
                onPress={() => router.push('/auth/scan')} />
            </YStack>
          )}
        </YStack>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.canvas },
  logo: { width: 60, height: 60, borderRadius: 16 },
});
