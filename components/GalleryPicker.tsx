// In-app gallery picker — replaces the system ACTION_GET_CONTENT picker, which
// on GMS-less ROMs (Huawei etc.) routes to the Files/DocumentsUI app instead of
// the photo gallery, and which backgrounds the app (dropping the relay socket
// mid-import). This reads the device's photos directly via expo-media-library
// and renders a branded multi-select grid, so selection stays in-app: direct to
// the gallery, no app backgrounding, identical on every device.
//
// Selection is built for backlogs of thousands of photos:
//   - day-grouped sections with a per-day select-all toggle
//   - swipe-select: a mostly-horizontal drag starting on a cell sweeps a range
//     (selects or deselects to match the anchor cell), with edge auto-scroll
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import { Check, ChevronDown } from 'lucide-react-native';

import { colors } from '../theme/colors';

export type PickedAsset = { uri: string; mimeType: string; fileName: string };

const NUM_COLUMNS = 4;
const GAP = 2;
const PAGE_SIZE = 300;
const HEADER_H = 40;
const EDGE_PX = 72;        // auto-scroll trigger band at list top/bottom
const EDGE_SPEED = 14;     // px per frame at full speed
const RESOLVE_BATCH = 32;  // getAssetInfoAsync concurrency on confirm

function extToMime(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

type HeaderRow = { type: 'header'; key: string; label: string; ids: string[] };
type PhotoRow = { type: 'photos'; key: string; assets: MediaLibrary.Asset[]; startIndex: number };
type Row = HeaderRow | PhotoRow;

// Album cover — lazily pulls the album's newest photo. One first:1 query per
// visible row; FlatList virtualization keeps the total bounded.
const AlbumCover = memo(function AlbumCover({ albumId, size }: {
  albumId: string | null;   // null = the all-photos pseudo album
  size: number;
}) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    MediaLibrary.getAssetsAsync({
      mediaType: MediaLibrary.MediaType.photo,
      sortBy: [MediaLibrary.SortBy.creationTime],
      first: 1,
      ...(albumId ? { album: albumId } : {}),
    })
      .then(page => { if (active) setUri(page.assets[0]?.uri ?? null); })
      .catch(() => {});
    return () => { active = false; };
  }, [albumId]);
  return (
    <View style={{ width: size, height: size, borderRadius: 8, overflow: 'hidden', backgroundColor: colors.bg.thumb }}>
      {uri && (
        <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={0} />
      )}
    </View>
  );
});

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
        {isSel && (
          <Text style={[styles.badgeText, selIdx >= 999 && styles.badgeTextSmall]}>
            {selIdx + 1}
          </Text>
        )}
      </View>
    </Pressable>
  );
});

const DayHeader = memo(function DayHeader({ label, ids, selectedInGroup, onToggleGroup }: {
  label: string;
  ids: string[];
  selectedInGroup: number;
  onToggleGroup: (ids: string[]) => void;
}) {
  const all = selectedInGroup === ids.length;
  return (
    <View style={styles.dayHeader}>
      <Text style={styles.dayLabel}>
        {label}
        <Text style={styles.dayCount}>  {ids.length} 张</Text>
      </Text>
      <Pressable onPress={() => onToggleGroup(ids)} hitSlop={8}>
        <Text style={[styles.dayAll, all && styles.dayAllOn]}>
          {all ? '取消全选' : '全选'}
        </Text>
      </Pressable>
    </View>
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
  const [busyDone, setBusyDone] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Album browsing (2026-08-22 feedback): null = all photos. Selection is
  // kept across album switches — confirm resolves ids through seenRef, which
  // accumulates every asset any loaded page has shown, so ids picked in
  // album A survive browsing into album B.
  const [albums, setAlbums] = useState<MediaLibrary.Album[]>([]);
  const [album, setAlbum] = useState<MediaLibrary.Album | null>(null);
  const [albumsOpen, setAlbumsOpen] = useState(false);
  const seenRef = useRef<Map<string, MediaLibrary.Asset>>(new Map());
  const albumsLoadedRef = useRef(false);

  const cell = Math.floor(
    (Dimensions.get('window').width - GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS,
  );
  const rowH = cell + GAP;

  const selSet = useMemo(() => new Set(selected), [selected]);
  const selIdxOf = useMemo(() => {
    const m = new Map<string, number>();
    selected.forEach((id, i) => m.set(id, i));
    return m;
  }, [selected]);

  // Day-grouped rows. `assets` is already creationTime-sorted (query sort),
  // so the flat asset index doubles as the sweep order for drag-select.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let i = 0;
    while (i < assets.length) {
      const key = dayKey(assets[i].creationTime);
      const groupStart = i;
      while (i < assets.length && dayKey(assets[i].creationTime) === key) i++;
      const group = assets.slice(groupStart, i);
      out.push({
        type: 'header',
        key: `h-${key}`,
        label: dayLabel(group[0].creationTime),
        ids: group.map(a => a.id),
      });
      for (let j = 0; j < group.length; j += NUM_COLUMNS) {
        out.push({
          type: 'photos',
          key: `p-${key}-${j}`,
          assets: group.slice(j, j + NUM_COLUMNS),
          startIndex: groupStart + j,
        });
      }
    }
    return out;
  }, [assets]);

  // Cumulative y offset per row — shared by getItemLayout and drag hit-testing.
  const rowOffsets = useMemo(() => {
    const ys = new Array<number>(rows.length);
    let y = 0;
    for (let i = 0; i < rows.length; i++) {
      ys[i] = y;
      y += rows[i].type === 'header' ? HEADER_H : rowH;
    }
    return { ys, total: y };
  }, [rows, rowH]);

  const loadPage = useCallback(async (after?: string) => {
    setLoading(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: MediaLibrary.MediaType.photo,
        sortBy: [MediaLibrary.SortBy.creationTime],
        first: PAGE_SIZE,
        after,
        ...(album ? { album: album.id } : {}),
      });
      for (const a of page.assets) seenRef.current.set(a.id, a);
      setAssets(prev => (after ? [...prev, ...page.assets] : page.assets));
      setCursor(page.endCursor);
      setHasNext(page.hasNextPage);
    } catch (e) {
      console.warn('[gallery] load failed', e);
    } finally {
      setLoading(false);
    }
  }, [album]);

  useEffect(() => {
    if (!visible) {
      setSelected([]);
      setAlbum(null);
      setAlbumsOpen(false);
      seenRef.current = new Map();
      albumsLoadedRef.current = false;
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
        // Album list is a one-shot per open (the effect re-runs on album
        // switch via loadPage's identity) — a stale count is fine for the
        // session. Empty albums are dropped.
        if (!albumsLoadedRef.current) {
          albumsLoadedRef.current = true;
          MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true })
            .then(all => {
              if (!active) { albumsLoadedRef.current = false; return; }
              setAlbums(
                all
                  .filter(a => (a.assetCount ?? 0) > 0)
                  .sort((a, b) => (b.assetCount ?? 0) - (a.assetCount ?? 0)),
              );
            })
            .catch(() => { albumsLoadedRef.current = false; });
        }
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

  const toggleGroup = useCallback((ids: string[]) => {
    setSelected(prev => {
      const have = new Set(prev);
      const allIn = ids.every(id => have.has(id));
      if (allIn) {
        const drop = new Set(ids);
        return prev.filter(id => !drop.has(id));
      }
      return [...prev, ...ids.filter(id => !have.has(id))];
    });
  }, []);

  // ---- swipe-select ------------------------------------------------------
  // Refs (not state): the responder callbacks and the auto-scroll loop run
  // outside React's render cycle and need current values synchronously.
  const listRef = useRef<FlatList<Row>>(null);
  const scrollYRef = useRef(0);
  const viewportRef = useRef({ h: 0, winY: 0, winX: 0 });
  const wrapRef = useRef<View>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const offsetsRef = useRef(rowOffsets);
  offsetsRef.current = rowOffsets;
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const dragRef = useRef<{
    active: boolean;
    anchor: number;
    target: boolean;          // true = sweep selects, false = sweep deselects
    snapshot: string[];       // selection at drag start
    snapshotSet: Set<string>;
    lastX: number;
    lastY: number;            // viewport-local finger position
  } | null>(null);
  const autoScrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Selection snapshot for the capture callback (runs outside render).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Viewport-local point → flat asset index (or null when over a header/gap).
  const hitTest = useCallback((x: number, y: number): number | null => {
    const { ys } = offsetsRef.current;
    const curRows = rowsRef.current;
    if (!curRows.length) return null;
    const contentY = y + scrollYRef.current;
    let lo = 0;
    let hi = curRows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ys[mid] <= contentY) lo = mid;
      else hi = mid - 1;
    }
    const row = curRows[lo];
    if (row.type !== 'photos') return null;
    const col = Math.max(0, Math.min(NUM_COLUMNS - 1, Math.floor(x / (cell + GAP))));
    return row.startIndex + Math.min(col, row.assets.length - 1);
  }, [cell]);

  const applySweep = useCallback((cur: number) => {
    const d = dragRef.current;
    if (!d || !d.active) return;
    const ids = assetsRef.current;
    const lo = Math.min(d.anchor, cur);
    const hi = Math.max(d.anchor, cur);
    if (d.target) {
      const add: string[] = [];
      for (let i = lo; i <= hi && i < ids.length; i++) {
        const id = ids[i].id;
        if (!d.snapshotSet.has(id)) add.push(id);
      }
      setSelected([...d.snapshot, ...add]);
    } else {
      const drop = new Set<string>();
      for (let i = lo; i <= hi && i < ids.length; i++) drop.add(ids[i].id);
      setSelected(d.snapshot.filter(id => !drop.has(id)));
    }
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollTimer.current) {
      clearInterval(autoScrollTimer.current);
      autoScrollTimer.current = null;
    }
  }, []);

  const maybeAutoScroll = useCallback((y: number) => {
    const { h } = viewportRef.current;
    if (!h) return;
    const nearTop = y < EDGE_PX;
    const nearBottom = y > h - EDGE_PX;
    if (!nearTop && !nearBottom) {
      stopAutoScroll();
      return;
    }
    if (autoScrollTimer.current) return;
    autoScrollTimer.current = setInterval(() => {
      const d = dragRef.current;
      if (!d || !d.active) {
        stopAutoScroll();
        return;
      }
      const { h: vh } = viewportRef.current;
      const fy = d.lastY;
      let dyPerTick = 0;
      if (fy < EDGE_PX) dyPerTick = -EDGE_SPEED * (1 - fy / EDGE_PX);
      else if (fy > vh - EDGE_PX) dyPerTick = EDGE_SPEED * (1 - (vh - fy) / EDGE_PX);
      if (!dyPerTick) return;
      const maxY = Math.max(0, offsetsRef.current.total - vh);
      const next = Math.max(0, Math.min(maxY, scrollYRef.current + dyPerTick));
      if (next === scrollYRef.current) return;
      scrollYRef.current = next;
      listRef.current?.scrollToOffset({ offset: next, animated: false });
      const idx = hitTest(d.lastX, d.lastY);
      if (idx != null) applySweep(idx);
    }, 16);
  }, [applySweep, hitTest, stopAutoScroll]);

  const endDrag = useCallback(() => {
    stopAutoScroll();
    if (dragRef.current) dragRef.current.active = false;
    setDragging(false);
  }, [stopAutoScroll]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponderCapture: (_evt, g) => {
          // A mostly-horizontal drag that starts on a photo cell begins a
          // sweep; vertical movement stays with the FlatList scroll.
          if (Math.abs(g.dx) < 10 || Math.abs(g.dx) <= Math.abs(g.dy) * 1.2) return false;
          const { winX, winY } = viewportRef.current;
          const x = g.x0 - winX;
          const y = g.y0 - winY;
          const idx = hitTest(x, y);
          if (idx == null) return false;
          const id = assetsRef.current[idx]?.id;
          if (!id) return false;
          const snapshot = selectedRef.current;
          dragRef.current = {
            active: true,
            anchor: idx,
            target: !snapshot.includes(id),
            snapshot,
            snapshotSet: new Set(snapshot),
            lastX: x,
            lastY: y,
          };
          setDragging(true);
          applySweep(idx);
          return true;
        },
        onPanResponderMove: (_evt, g) => {
          const d = dragRef.current;
          if (!d || !d.active) return;
          const { winX, winY } = viewportRef.current;
          const x = g.moveX - winX;
          const y = g.moveY - winY;
          d.lastX = x;
          d.lastY = y;
          const idx = hitTest(x, y);
          if (idx != null) applySweep(idx);
          maybeAutoScroll(y);
        },
        onPanResponderRelease: endDrag,
        onPanResponderTerminate: endDrag,
        onPanResponderTerminationRequest: () => false,
      }),
    [applySweep, endDrag, hitTest, maybeAutoScroll],
  );

  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const confirm = useCallback(async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    setBusyDone(0);
    try {
      // seenRef, not the current assets array — a selection made in one album
      // must survive the user browsing into another before confirming.
      const chosen = selected
        .map(id => seenRef.current.get(id))
        .filter(Boolean) as MediaLibrary.Asset[];
      // Batched, not one flat Promise.all — 5000-wide getAssetInfoAsync stalls
      // with zero feedback and can starve the JS thread.
      const out: PickedAsset[] = [];
      for (let i = 0; i < chosen.length; i += RESOLVE_BATCH) {
        const batch = chosen.slice(i, i + RESOLVE_BATCH);
        const resolved = await Promise.all(
          batch.map(async a => {
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
        out.push(...resolved);
        setBusyDone(out.length);
      }
      onConfirm(out);
    } finally {
      setBusy(false);
    }
  }, [selected, busy, onConfirm]);

  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      if (item.type === 'header') {
        let n = 0;
        for (const id of item.ids) if (selSet.has(id)) n++;
        return (
          <DayHeader
            label={item.label}
            ids={item.ids}
            selectedInGroup={n}
            onToggleGroup={toggleGroup}
          />
        );
      }
      return (
        <View style={{ flexDirection: 'row' }}>
          {item.assets.map(a => (
            <PickCell
              key={a.id}
              asset={a}
              size={cell}
              selIdx={selIdxOf.get(a.id) ?? -1}
              onToggle={toggle}
            />
          ))}
        </View>
      );
    },
    [selSet, selIdxOf, cell, toggle, toggleGroup],
  );

  const getItemLayout = useCallback(
    (_: ArrayLike<Row> | null | undefined, index: number) => {
      const { ys } = offsetsRef.current;
      const row = rowsRef.current[index];
      return {
        length: row && row.type === 'header' ? HEADER_H : rowH,
        offset: ys[index] ?? 0,
        index,
      };
    },
    [rowH],
  );

  const measureWrap = useCallback(() => {
    wrapRef.current?.measureInWindow((x, y, _w, h) => {
      viewportRef.current = { winX: x, winY: y, h };
    });
  }, []);

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
          <Pressable
            onPress={() => setAlbumsOpen(v => !v)}
            hitSlop={10}
            disabled={perm !== 'granted'}
            style={styles.titleBtn}
          >
            <Text style={styles.title} numberOfLines={1}>
              {album ? album.title : '全部照片'}
            </Text>
            <ChevronDown
              size={16}
              color={colors.text.secondary}
              style={{ transform: [{ rotate: albumsOpen ? '180deg' : '0deg' }] }}
            />
          </Pressable>
          <Pressable
            onPress={confirm}
            hitSlop={10}
            disabled={!selected.length || busy}
          >
            <Text style={[styles.done, (!selected.length || busy) && styles.doneOff]}>
              {busy
                ? `处理中 ${busyDone}/${selected.length}`
                : `完成${selected.length ? ` (${selected.length})` : ''}`}
            </Text>
          </Pressable>
        </View>

        {perm === 'denied' ? (
          <View style={styles.center}>
            <Text style={styles.denyText}>
              需要相册权限才能选图。请在系统设置里开启 Nephele 的照片访问。
            </Text>
          </View>
        ) : albumsOpen ? (
          <FlatList
            data={[null, ...albums] as (MediaLibrary.Album | null)[]}
            keyExtractor={a => (a ? a.id : '__all__')}
            renderItem={({ item }) => {
              const current = (item?.id ?? null) === (album?.id ?? null);
              return (
                <Pressable
                  style={({ pressed }) => [styles.albumRow, pressed && { opacity: 0.6 }]}
                  onPress={() => {
                    setAlbumsOpen(false);
                    if (!current) setAlbum(item);
                  }}
                >
                  <AlbumCover albumId={item?.id ?? null} size={52} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.albumName} numberOfLines={1}>
                      {item ? item.title : '全部照片'}
                    </Text>
                    {item != null && (
                      <Text style={styles.albumCount}>{item.assetCount} 项</Text>
                    )}
                  </View>
                  {current && <Check size={18} color={colors.brand.primary} />}
                </Pressable>
              );
            }}
          />
        ) : (
          <View
            ref={wrapRef}
            style={{ flex: 1 }}
            onLayout={measureWrap}
            // Re-measure on touch: onLayout can fire mid slide-in animation and
            // capture a translated winY, which would skew every sweep hit-test.
            onTouchStart={measureWrap}
            {...panResponder.panHandlers}
          >
            <FlatList
              ref={listRef}
              data={rows}
              keyExtractor={r => r.key}
              renderItem={renderItem}
              getItemLayout={getItemLayout}
              scrollEnabled={!dragging}
              onScroll={e => {
                scrollYRef.current = e.nativeEvent.contentOffset.y;
              }}
              scrollEventThrottle={16}
              onEndReached={() => {
                if (hasNext && !loading) loadPage(cursor);
              }}
              onEndReachedThreshold={1.5}
              initialNumToRender={16}
              windowSize={7}
              removeClippedSubviews
              ListFooterComponent={
                loading ? (
                  <ActivityIndicator color={colors.brand.primary} style={{ margin: 20 }} />
                ) : null
              }
            />
          </View>
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
  title: { color: colors.text.primary, fontSize: 16, fontWeight: '600', maxWidth: 200 },
  titleBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cancel: { color: colors.text.secondary, fontSize: 15 },
  done: { color: colors.brand.primary, fontSize: 15, fontWeight: '600' },
  doneOff: { color: colors.text.faint },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  denyText: { color: colors.text.secondary, textAlign: 'center', lineHeight: 22 },
  dayHeader: {
    height: HEADER_H,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
  },
  dayLabel: { color: colors.text.primary, fontSize: 14, fontWeight: '600' },
  dayCount: { color: colors.text.tertiary, fontSize: 12, fontWeight: '400' },
  dayAll: { color: colors.brand.primary, fontSize: 13, fontWeight: '600' },
  dayAllOn: { color: colors.text.tertiary },
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
  badgeTextSmall: { fontSize: 9 },
  albumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  albumName: { color: colors.text.primary, fontSize: 15, fontWeight: '500' },
  albumCount: { color: colors.text.tertiary, fontSize: 12, marginTop: 2 },
});
