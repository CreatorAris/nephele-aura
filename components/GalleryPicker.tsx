// In-app gallery picker — replaces the system ACTION_GET_CONTENT picker, which
// on GMS-less ROMs (Huawei etc.) routes to the Files/DocumentsUI app instead of
// the photo gallery, and which backgrounds the app (dropping the relay socket
// mid-import). This reads the device's photos directly via expo-media-library
// and renders a branded multi-select grid, so selection stays in-app: direct to
// the gallery, no app backgrounding, identical on every device.
import { memo, useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';

import { colors } from '../theme/colors';

export type PickedAsset = { uri: string; mimeType: string; fileName: string };

const NUM_COLUMNS = 4;
const GAP = 2;
const PAGE_SIZE = 90;

function extToMime(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}

// Memoized cell: `selected` changes identity on every tap, which changes
// renderItem's identity and re-renders every mounted row — memo() cuts that
// to the one or two cells whose selIdx actually changed.
const PickCell = memo(function PickCell({ asset, size, selIdx, onToggle }: {
  asset: MediaLibrary.Asset;
  size: number;
  selIdx: number;   // -1 = unselected
  onToggle: (id: string) => void;
}) {
  const isSel = selIdx >= 0;
  return (
    <Pressable
      onPress={() => onToggle(asset.id)}
      style={{ width: size, height: size, marginRight: GAP, marginBottom: GAP }}
    >
      <Image
        source={{ uri: asset.uri }}
        style={{ width: '100%', height: '100%', backgroundColor: colors.bg.thumb }}
        contentFit="cover"
        recyclingKey={asset.id}
        transition={0}
      />
      {isSel && <View style={styles.selOverlay} />}
      <View style={[styles.badge, isSel && styles.badgeOn]}>
        {isSel && <Text style={styles.badgeText}>{selIdx + 1}</Text>}
      </View>
    </Pressable>
  );
});

export function GalleryPicker({
  visible,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: (assets: PickedAsset[]) => void;
}) {
  const [perm, setPerm] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasNext, setHasNext] = useState(true);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]); // ordered asset ids
  const [busy, setBusy] = useState(false); // resolving file uris on confirm

  const cell = Math.floor(
    (Dimensions.get('window').width - GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS,
  );

  const loadPage = useCallback(async (after?: string) => {
    setLoading(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: MediaLibrary.MediaType.photo,
        sortBy: [MediaLibrary.SortBy.creationTime],
        first: PAGE_SIZE,
        after,
      });
      setAssets(prev => (after ? [...prev, ...page.assets] : page.assets));
      setCursor(page.endCursor);
      setHasNext(page.hasNextPage);
    } catch (e) {
      console.warn('[gallery] load failed', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      setSelected([]);
      return;
    }
    let active = true;
    (async () => {
      // Already granted/limited → straight to the grid; only actually ask
      // when we have nothing (repeated requestPermissionsAsync re-surfaces
      // the system sheet on limited-access devices every open).
      let res = await MediaLibrary.getPermissionsAsync();
      if (!res.granted && res.accessPrivileges !== 'limited' && res.canAskAgain !== false) {
        res = await MediaLibrary.requestPermissionsAsync(false);
      }
      if (!active) return;
      if (res.granted || res.accessPrivileges === 'limited') {
        setPerm('granted');
        setAssets([]);
        setCursor(undefined);
        setHasNext(true);
        loadPage(undefined);
      } else {
        setPerm('denied');
      }
    })();
    return () => {
      active = false;
    };
  }, [visible, loadPage]);

  const toggle = useCallback((id: string) => {
    setSelected(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id],
    );
  }, []);

  const confirm = useCallback(async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    try {
      const byId = new Map(assets.map(a => [a.id, a]));
      const chosen = selected
        .map(id => byId.get(id))
        .filter(Boolean) as MediaLibrary.Asset[];
      const out = await Promise.all(
        chosen.map(async a => {
          let uri = a.uri;
          try {
            const info = await MediaLibrary.getAssetInfoAsync(a);
            if (info.localUri) uri = info.localUri;
          } catch {
            /* fall back to a.uri */
          }
          return { uri, mimeType: extToMime(a.filename), fileName: a.filename };
        }),
      );
      onConfirm(out);
    } finally {
      setBusy(false);
    }
  }, [selected, assets, busy, onConfirm]);

  const renderItem = useCallback(
    ({ item }: { item: MediaLibrary.Asset }) => (
      <PickCell asset={item} size={cell} selIdx={selected.indexOf(item.id)} onToggle={toggle} />
    ),
    [selected, cell, toggle],
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.cancel}>取消</Text>
          </Pressable>
          <Text style={styles.title}>选择图片</Text>
          <Pressable
            onPress={confirm}
            hitSlop={10}
            disabled={!selected.length || busy}
          >
            <Text style={[styles.done, (!selected.length || busy) && styles.doneOff]}>
              {busy ? '处理中' : `完成${selected.length ? ` (${selected.length})` : ''}`}
            </Text>
          </Pressable>
        </View>

        {perm === 'denied' ? (
          <View style={styles.center}>
            <Text style={styles.denyText}>
              需要相册权限才能选图。请在系统设置里开启 Nephele 的照片访问。
            </Text>
          </View>
        ) : (
          <FlatList
            data={assets}
            keyExtractor={a => a.id}
            numColumns={NUM_COLUMNS}
            renderItem={renderItem}
            onEndReached={() => {
              if (hasNext && !loading) loadPage(cursor);
            }}
            onEndReachedThreshold={1.5}
            initialNumToRender={24}
            windowSize={5}
            removeClippedSubviews
            ListFooterComponent={
              loading ? (
                <ActivityIndicator color={colors.brand.primary} style={{ margin: 20 }} />
              ) : null
            }
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg.canvas },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border.hairline,
  },
  title: { color: colors.text.primary, fontSize: 16, fontWeight: '600' },
  cancel: { color: colors.text.secondary, fontSize: 15 },
  done: { color: colors.brand.primary, fontSize: 15, fontWeight: '600' },
  doneOff: { color: colors.text.faint },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  denyText: { color: colors.text.secondary, textAlign: 'center', lineHeight: 22 },
  selOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 3,
    borderColor: colors.brand.primary,
    backgroundColor: 'rgba(206,172,224,0.25)',
  },
  badge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.overlay.onImage,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  badgeOn: { backgroundColor: colors.brand.primary, borderColor: colors.brand.primary },
  badgeText: { color: '#1A1438', fontSize: 12, fontWeight: '700' },
});
