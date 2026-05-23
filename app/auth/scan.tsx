import { StyleSheet, View, Pressable } from 'react-native';
import { YStack, Text, Button, Spinner } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState, useRef, useCallback } from 'react';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import { X } from 'lucide-react-native';
import { exchangePairingToken } from '../../utils/auth';
import { colors } from '../../theme/colors';

const TOKEN_RE = /^[a-f0-9]{64}$/;

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lockRef = useRef(false);

  const handleScan = useCallback(async (r: BarcodeScanningResult) => {
    if (lockRef.current) return;
    const raw = (r.data || '').trim();
    // Accept either raw 64-hex token or nephele://pair?token=XXX format
    let token = raw;
    if (raw.startsWith('nephele://pair')) {
      const m = raw.match(/token=([a-f0-9]{64})/i);
      token = m ? m[1] : '';
    }
    if (!TOKEN_RE.test(token)) {
      setError('二维码格式不正确');
      return;
    }
    lockRef.current = true;
    setBusy(true);
    setError('');
    const result = await exchangePairingToken(token);
    if (result.success) {
      router.replace('/(tabs)');
    } else {
      setError(result.message);
      setBusy(false);
      // Re-arm scanning after a beat so the user can retry without leaving
      setTimeout(() => { lockRef.current = false; }, 1500);
    }
  }, []);

  if (!permission) {
    return (
      <SafeAreaView style={styles.container}>
        <YStack flex={1} justifyContent="center" alignItems="center">
          <Spinner size="large" color={colors.brand.primary} />
        </YStack>
      </SafeAreaView>
    );
  }
  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.container}>
        <YStack flex={1} justifyContent="center" alignItems="center" paddingHorizontal="$5" gap="$4">
          <Text fontSize={16} color={colors.text.primary} textAlign="center">
            需要相机权限以扫描桌面二维码
          </Text>
          <Button size="$5" backgroundColor={colors.brand.primary} borderRadius="$3"
            onPress={requestPermission}>
            <Text color={colors.bg.canvas} fontWeight="600" fontSize={16}>授予权限</Text>
          </Button>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Text color={colors.text.tertiary} fontSize={14}>返回</Text>
          </Pressable>
        </YStack>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={busy ? undefined : handleScan}
      />
      <SafeAreaView style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
        <YStack flex={1} justifyContent="space-between">
          <View style={styles.topBar}>
            <Pressable onPress={() => router.back()} hitSlop={12} style={styles.closeBtn}>
              <X size={22} color="#fff" />
            </Pressable>
            <Text color="#fff" fontSize={15} fontWeight="600">扫描桌面二维码</Text>
            <View style={styles.closeBtn} />
          </View>
          <View style={styles.frameWrap}>
            <View style={styles.frame} />
          </View>
          <YStack alignItems="center" paddingHorizontal="$5" paddingBottom="$5" gap="$3">
            {busy ? (
              <YStack alignItems="center" gap="$2">
                <Spinner size="large" color="#fff" />
                <Text color="#fff" fontSize={14}>正在登录...</Text>
              </YStack>
            ) : error ? (
              <Text color={colors.status.error} fontSize={14} textAlign="center">{error}</Text>
            ) : (
              <Text color="rgba(255,255,255,0.85)" fontSize={13} textAlign="center">
                把镜头对准桌面端 Nephele 显示的二维码
              </Text>
            )}
          </YStack>
        </YStack>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
  },
  frameWrap: { alignItems: 'center', justifyContent: 'center' },
  frame: {
    width: 240, height: 240, borderWidth: 2, borderColor: 'rgba(255,255,255,0.9)',
    borderRadius: 16,
  },
});
