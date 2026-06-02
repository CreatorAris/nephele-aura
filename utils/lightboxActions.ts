// Shared per-image actions for every lightbox (gallery / feed / picker). Keeps
// the share + save-to-album logic in one place so call sites only spread
// standardImageActions() into the lightbox's `actions` prop and bake `tags`
// onto each ImageSource.
//
// Feedback uses ToastAndroid (renders OVER the lightbox Modal on Android, our
// primary platform); iOS falls back to a minimal Alert.

import { Alert, Platform, ToastAndroid } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Haptics from 'expo-haptics';
import Share from 'react-native-share';
import type { ImageSource, LightboxAction } from '../components/Lightbox';

function toast(msg: string): void {
  if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert('', msg);
}

function extFor(url: string): 'png' | 'jpg' {
  return /\.png(\?|$)/i.test(url) ? 'png' : 'jpg';
}

// react-native-share needs a local file:// uri; the source may be an R2/LAN URL.
async function downloadToCache(url: string): Promise<string> {
  const dest = `${FileSystem.cacheDirectory}lb_${Date.now()}.${extFor(url)}`;
  const { uri } = await FileSystem.downloadAsync(url, dest);
  return uri;
}

export async function shareImage(img: ImageSource): Promise<void> {
  const url = img.uri || img.thumbUri;
  if (!url) { toast('图片尚未加载完成'); return; }
  try {
    const localUri = await downloadToCache(url);
    const tags = (img.tags || []).filter((t) => !!t && !!t.trim());
    await Share.open({
      url: localUri,
      type: extFor(url) === 'png' ? 'image/png' : 'image/jpeg',
      message: tags.length ? tags.join(' ') : undefined,
      failOnCancel: false,
    });
  } catch {
    // failOnCancel:false → user dismissal doesn't throw; only real errors land here.
    toast('分享失败');
  }
}

export async function saveToAlbum(img: ImageSource): Promise<void> {
  const url = img.uri || img.thumbUri;
  if (!url) { toast('此图无法保存'); return; }
  try {
    const perm = await MediaLibrary.requestPermissionsAsync();
    if (!perm.granted) { toast('相册权限被拒绝'); return; }
    const localUri = await downloadToCache(url);
    await MediaLibrary.saveToLibraryAsync(localUri);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    toast('已保存到相册');
  } catch {
    toast('保存失败');
  }
}

// Standard actions present on every lightbox: 分享 + 保存到相册, plus any
// caller-specific extras (e.g. 保存到 Eagle) appended after.
export function standardImageActions(extra: LightboxAction[] = []): LightboxAction[] {
  return [
    { key: 'share', label: '分享', onPress: (img) => { void shareImage(img); } },
    { key: 'album', label: '保存到相册', onPress: (img) => { void saveToAlbum(img); } },
    ...extra,
  ];
}
