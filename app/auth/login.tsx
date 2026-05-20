import { StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { Image } from 'expo-image';
import { YStack, Text, Input, Button } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState, useEffect, useRef } from 'react';
import { router } from 'expo-router';
import { sendCode, verifyCode } from '../../utils/auth';

type Step = 'email' | 'code';

export default function LoginScreen() {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Countdown timer for resend
  useEffect(() => {
    if (countdown > 0) {
      timerRef.current = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            if (timerRef.current) clearInterval(timerRef.current);
            return 0;
          }
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
      setCountdown(60);
    } else {
      setError(result.message);
      if (result.retryAfter) setCountdown(result.retryAfter);
    }
  };

  const handleVerifyCode = async () => {
    if (code.trim().length < 4) {
      setError('请输入完整的验证码');
      return;
    }
    setError('');
    setLoading(true);

    const result = await verifyCode(email.trim().toLowerCase(), code.trim());
    setLoading(false);

    if (result.success) {
      router.replace('/(tabs)');
    } else {
      setError(result.message);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <YStack flex={1} justifyContent="center" paddingHorizontal="$5">
          {/* Logo */}
          <YStack alignItems="center" marginBottom="$8">
            <Image source={require('../../assets/icon.png')} style={styles.logo} />
            <Text fontSize={24} fontWeight="700" color="#1d1d1f" marginTop="$3">
              Nephele
            </Text>
            <Text fontSize={13} color="#999999" marginTop="$1">
              次世代画师的次世代工具
            </Text>
          </YStack>

          {step === 'email' ? (
            <YStack gap="$3">
              <Input
                placeholder="请输入邮箱"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                backgroundColor="#ffffff"
                borderColor="#e8e8e8"
                borderWidth={1}
                borderRadius="$3"
                paddingHorizontal="$3"
                color="#1d1d1f"
                size="$4"
                focusStyle={{ borderColor: '#b388ff' }}
                onSubmitEditing={handleSendCode}
              />

              {error !== '' && (
                <Text color="#FF383C" fontSize={13} textAlign="center">{error}</Text>
              )}

              <Button
                size="$5"
                backgroundColor="#b388ff"
                borderRadius="$3"
                pressStyle={{ opacity: 0.85 }}
                onPress={handleSendCode}
                disabled={loading}
              >
                <Text color="white" fontWeight="600" fontSize={16}>
                  {loading ? '发送中...' : '获取验证码'}
                </Text>
              </Button>
            </YStack>
          ) : (
            <YStack gap="$3">
              <Text color="#666666" fontSize={14} textAlign="center">
                验证码已发送至 {email}
              </Text>

              <Input
                placeholder="请输入验证码"
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                backgroundColor="#ffffff"
                borderColor="#e8e8e8"
                borderWidth={1}
                borderRadius="$3"
                paddingHorizontal="$3"
                color="#1d1d1f"
                size="$4"
                focusStyle={{ borderColor: '#b388ff' }}
                autoFocus
                maxLength={6}
                onSubmitEditing={handleVerifyCode}
              />

              {error !== '' && (
                <Text color="#FF383C" fontSize={13} textAlign="center">{error}</Text>
              )}

              <Button
                size="$5"
                backgroundColor="#b388ff"
                borderRadius="$3"
                pressStyle={{ opacity: 0.85 }}
                onPress={handleVerifyCode}
                disabled={loading}
              >
                <Text color="white" fontWeight="600" fontSize={16}>
                  {loading ? '验证中...' : '登录'}
                </Text>
              </Button>

              <Button
                size="$4"
                backgroundColor="transparent"
                borderRadius="$3"
                disabled={countdown > 0}
                onPress={handleSendCode}
              >
                <Text color={countdown > 0 ? '#bbbbbb' : '#b388ff'} fontSize={14}>
                  {countdown > 0 ? `${countdown}秒后可重新发送` : '重新发送验证码'}
                </Text>
              </Button>

              <Text
                color="#999999"
                fontSize={13}
                textAlign="center"
                pressStyle={{ opacity: 0.6 }}
                onPress={() => { setStep('email'); setCode(''); setError(''); }}
              >
                更换邮箱
              </Text>
            </YStack>
          )}

          {/* Skip */}
          <YStack alignItems="center" marginTop="$5">
            <Text
              color="#b388ff"
              fontSize={14}
              pressStyle={{ opacity: 0.6 }}
              onPress={() => router.replace('/(tabs)')}
            >
              暂时跳过
            </Text>
          </YStack>
        </YStack>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f7' },
  flex: { flex: 1 },
  logo: { width: 72, height: 72, borderRadius: 16 },
});
