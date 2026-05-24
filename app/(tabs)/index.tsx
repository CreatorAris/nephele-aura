import {
  Pressable, Dimensions, Modal, ScrollView, FlatList,
  BackHandler, Platform, StyleSheet, Alert, View, Keyboard,
} from 'react-native';
import { Image } from 'expo-image';
import { FlashList, type FlashListProps } from '@shopify/flash-list';
import { BlurView } from 'expo-blur';
import PagerView from 'react-native-pager-view';
import { LinearGradient as ExpoLinearGradient } from 'expo-linear-gradient';
import { YStack, XStack, Text, Spinner, Button, Input } from 'tamagui';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Unplug, Search, CircleX, ImagePlus, X, FolderPlus,
  Images, Check, Folder, SquareCheck, Square,
  Image as ImageIcon, Star, Tag, Trash2, CircleCheck,
  SlidersHorizontal, Crosshair, Link2, Plus, Camera,
  type LucideIcon,
} from 'lucide-react-native';
import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { useFocusEffect } from 'expo-router';
import Animated, {
  type AnimatedRef, useAnimatedRef,
  useSharedValue, useAnimatedStyle,
  withRepeat, withSequence, withTiming,
  FadeIn, FadeOut,
  useAnimatedScrollHandler, interpolate, Extrapolation,
} from 'react-native-reanimated';
import { remoteWS, RemoteMessage, RemoteWebSocket } from '../../utils/websocket';
import { isLoggedIn } from '../../utils/auth';
import { useLightbox, useLightboxControls, type ImageSource as LbImageSource } from '../../components/Lightbox';
import { colors } from '../../theme/colors';
import { TAB_BAR_CLEARANCE } from '../../components/FloatingTabBar';
import { uploadBus } from '../../utils/uploadBus';
import { AuraActionSheet } from '../../components/AuraActionSheet';
import * as ImagePicker from 'expo-image-picker';
import { useShareIntent } from 'expo-share-intent';

// --- Types ---

type LibraryFolder = {
  id: string; name: string;
  count?: number;
  imageCount?: number;
  folderCount?: number;
  // New in 2026-05-21: desktop now ships the full Eagle folder tree (instead
  // of a flat imageCount>0 subset), preserving color + nested children so
  // Aura can render the same visual identity as the desktop sidebar.
  color?: string;
  children?: LibraryFolder[];
};

type LibraryItem = {
  id: string; name: string; ext: string;
  width: number; height: number;
  tags: string[]; star: number;
  annotation: string; url: string; size: number;
  blurhash?: string;  // optional — populated by desktop's background backfill
};

// --- Constants ---

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;
const GAP = 6;
const PAD = 6;
const COL_W = (SCREEN_W - PAD * 2 - GAP) / 2;
const PAGE_SIZE = 40;
// Re-request a visible WAN thumb if it hasn't arrived within this window — a
// lost response (relay flap / dropped base64) must not blank a cell forever.
const THUMB_RETRY_MS = 6000;

// Collapsing-header geometry (px). Search row = field 44 + pad 14 + 12.
const SEARCH_ROW_H = 70;
const CHIPS_ROW_H = 46;

// createAnimatedComponent drops FlashList's generic, defaulting data to
// unknown[]; re-assert the item type so renderItem/keyExtractor stay typed.
const AnimatedFlashList = Animated.createAnimatedComponent(
  FlashList as unknown as React.ComponentClass<FlashListProps<LibraryItem>>,
);
const INFO_H = 26;

function fmtSize(b: number) {
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1048576).toFixed(1)}MB`;
}

// --- Main ---

export default function GalleryScreen() {
  // "Connected" in the gallery context means desktop is actually paired via
  // the relay — talking to the CF DO alone is not enough to fetch library data.
  const [connected, setConnected] = useState(
    remoteWS.getState() === 'connected' && remoteWS.getDesktopOnline()
  );
  const [wsState, setWsState] = useState(() => remoteWS.getState());
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [error, setError] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  // id → last-request timestamp (NOT a permanent blacklist — see requestMissingThumbs)
  const thumbRequested = useRef<Map<string, number>>(new Map());
  const visibleIds = useRef<Set<string>>(new Set());
  const [detailItem, setDetailItem] = useState<LibraryItem | null>(null);
  const [fileServerUrl, setFileServerUrl] = useState<string | null>(null);
  const { openLightbox: openLightboxControl, closeLightbox: closeLightboxControl } = useLightboxControls();
  const { activeLightbox } = useLightbox();

  // Multi-select (P2.4): entered via explicit Select button (iOS habit) or
  // long-press on a cell (Android habit). Exits on Cancel or Android back.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Folder create/rename dialog (P2.5)
  type FolderDialogState =
    | { mode: 'create' }
    | { mode: 'rename'; folder: LibraryFolder }
    | null;
  const [folderDialog, setFolderDialog] = useState<FolderDialogState>(null);

  // Import from phone gallery → library (Phase 3)
  type ImportState =
    | { stage: 'idle' }
    | { stage: 'uploading'; current: number; total: number; failed: number }
    | { stage: 'importing'; uploaded: number; total: number; progress: number; failed: number }
    | { stage: 'done'; processed: number; failed: number; total: number };
  const [importState, setImportState] = useState<ImportState>({ stage: 'idle' });
  const [importSheetVisible, setImportSheetVisible] = useState(false);

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const searchInputRef = useRef<any>(null);  // Tamagui Input → TextInput (.blur())
  // Android: dismissing the keyboard (back / gesture) does NOT blur the
  // TextInput, so onBlur never fires and the cancel button would linger. Drop
  // the focused state whenever the keyboard hides, by any means.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      setSearchFocused(false);
      searchInputRef.current?.blur?.();
    });
    return () => sub.remove();
  }, []);

  // --- Collapsing frosted header (scroll-driven) ---
  const insets = useSafeAreaInsets();
  const headerTop = insets.top + SEARCH_ROW_H + CHIPS_ROW_H;       // expanded header height
  const listTopPad = selectMode ? insets.top + 56 : headerTop;     // content starts below header
  const scrollY = useSharedValue(0);
  const scrollHandler = useAnimatedScrollHandler((e) => { scrollY.value = e.contentOffset.y; });
  // Search row collapses as you scroll down (1:1 with scroll so it "rolls up"
  // with the content); chips row stays.
  const searchCollapseStyle = useAnimatedStyle(() => ({
    height: interpolate(scrollY.value, [0, SEARCH_ROW_H], [SEARCH_ROW_H, 0], Extrapolation.CLAMP),
    opacity: interpolate(scrollY.value, [0, SEARCH_ROW_H * 0.7], [1, 0], Extrapolation.CLAMP),
    overflow: 'hidden',
  }));
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [allTags, setAllTags] = useState<{ name: string; count: number }[]>([]);
  const [activeFolder, setActiveFolder] = useState<LibraryFolder | null>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [activeRating, setActiveRating] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const updateConnected = () => setConnected(
      remoteWS.getState() === 'connected' && remoteWS.getDesktopOnline()
    );
    const unsubState = remoteWS.onStateChange((s) => {
      setWsState(s);
      updateConnected();
    });
    const unsubDesktop = remoteWS.onDesktopStateChange(updateConnected);
    return () => { unsubState(); unsubDesktop(); };
  }, []);

  // Current search params (for loadMore)
  const searchParamsRef = useRef({
    keyword: '', tags: [] as string[], rating: 0, folderId: '',
  });

  // Android back button
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (activeLightbox) {
          closeLightboxControl();
          return true;
        }
        if (selectMode) {
          setSelectMode(false); setSelectedIds(new Set());
          return true;
        }
        if (detailItem) { setDetailItem(null); return true; }
        if (tagPickerOpen) { setTagPickerOpen(false); return true; }
        if (filterOpen) { setFilterOpen(false); return true; }
        if (searchQuery || activeTags.length || activeRating || activeFolder) {
          clearAllFilters(); return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [activeLightbox, closeLightboxControl, selectMode, detailItem, filterOpen, tagPickerOpen,
        searchQuery, activeTags.length, activeRating, activeFolder])
  );

  // Select-mode handlers
  const exitSelectMode = useCallback(() => {
    setSelectMode(false); setSelectedIds(new Set());
  }, []);

  const enterSelectMode = useCallback((seedId?: string) => {
    setSelectMode(true);
    setSelectedIds(seedId ? new Set([seedId]) : new Set());
    // Close any open detail modal to avoid input conflict
    setDetailItem(null);
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Batch rate — applies the same star value to every selected item
  const batchSetStar = useCallback((star: number) => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setItems(prev => prev.map(it => selectedIds.has(it.id) ? { ...it, star } : it));
    remoteWS.batchUpdateItems(ids, { star });
  }, [selectedIds]);

  // Batch add tag — appends the tag to every selected item (no duplicates)
  const batchAddTag = useCallback((tag: string) => {
    const t = tag.trim();
    if (!t || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setItems(prev => prev.map(it => {
      if (!selectedIds.has(it.id)) return it;
      if (it.tags.includes(t)) return it;
      return { ...it, tags: [...it.tags, t] };
    }));
    // Server-side batch_update replaces tags entirely; safer to send per-item
    // patches so we preserve each item's existing tags + append.
    for (const id of ids) {
      const item = items.find(i => i.id === id);
      if (!item) continue;
      if (item.tags.includes(t)) continue;
      remoteWS.updateItem(id, { tags: [...item.tags, t] });
    }
  }, [selectedIds, items]);

  // Phone gallery/camera → library import (Phase 3). Sequential R2 upload
  // (concurrency 1 keeps the radio happy and lets us report a meaningful
  // per-item progress). Imports into the currently active folder if one is
  // selected.
  const processAssets = useCallback(async (
    assets: { uri: string; mimeType?: string | null }[],
  ) => {
    const total = assets.length;
    const urls: string[] = [];
    let failed = 0;
    setImportState({ stage: 'uploading', current: 0, total, failed: 0 });

    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      try {
        const mime = a.mimeType || (a.uri.endsWith('.png') ? 'image/png' : 'image/jpeg');
        const url = await RemoteWebSocket.uploadImage(a.uri, mime);
        urls.push(url);
      } catch (e) {
        failed += 1;
        console.warn('[import] upload failed', e);
      }
      setImportState({ stage: 'uploading', current: i + 1, total, failed });
    }

    if (urls.length === 0) {
      setImportState({ stage: 'done', processed: 0, failed, total });
      return;
    }

    setImportState({
      stage: 'importing', uploaded: urls.length, total,
      progress: 0, failed,
    });
    remoteWS.importFiles(urls, { folderId: activeFolder?.id });
  }, [activeFolder]);

  const importFromGallery = useCallback(async () => {
    if (importState.stage !== 'idle' && importState.stage !== 'done') return;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('需要相册权限', '请在系统设置里开启 Nephele 的相册访问。');
        return;
      }
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: 20,
        quality: 1,
      });
      if (picked.canceled || picked.assets.length === 0) return;
      await processAssets(picked.assets);
    } catch (e) {
      console.warn('[import] aborted', e);
      setImportState({ stage: 'idle' });
      Alert.alert('导入失败', String(e));
    }
  }, [importState.stage, processAssets]);

  const importFromCamera = useCallback(async () => {
    if (importState.stage !== 'idle' && importState.stage !== 'done') return;
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('需要相机权限', '请在系统设置里开启 Nephele 的相机访问。');
        return;
      }
      const picked = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 1,
      });
      if (picked.canceled || picked.assets.length === 0) return;
      await processAssets(picked.assets);
    } catch (e) {
      console.warn('[import] aborted', e);
      setImportState({ stage: 'idle' });
      Alert.alert('拍照失败', String(e));
    }
  }, [importState.stage, processAssets]);

  const chooseImportSource = useCallback(() => {
    if (importState.stage !== 'idle' && importState.stage !== 'done') return;
    setImportSheetVisible(true);
  }, [importState.stage]);

  // The global floating tab bar's center "+" button triggers this same picker
  // (via uploadBus, since the import flow owns WS/file-server state here).
  useEffect(() => {
    uploadBus.setHandler(chooseImportSource);
    return () => uploadBus.setHandler(null);
  }, [chooseImportSource]);

  // Cross-app share: receive images shared from Twitter / X / Pixiv / gallery
  // etc. via Android system share sheet. Same upload+import pipeline as the
  // in-app gallery picker. Holds off while another import is in flight so we
  // don't trample importState; the intent stays cached until we reset it.
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({
    resetOnBackground: true,
  });
  useEffect(() => {
    if (!hasShareIntent || !shareIntent?.files?.length) return;
    if (importState.stage === 'uploading' || importState.stage === 'importing') return;
    const assets = shareIntent.files
      .filter(f => (f.mimeType || '').startsWith('image/'))
      .map(f => ({
        uri: f.path.startsWith('file://') ? f.path : `file://${f.path}`,
        mimeType: f.mimeType,
      }));
    if (assets.length === 0) {
      resetShareIntent();
      return;
    }
    processAssets(assets).finally(() => resetShareIntent());
  }, [hasShareIntent, shareIntent, importState.stage, processAssets, resetShareIntent]);

  // Ref so the import listener can call doSearch (declared later) without
  // creating a use-before-declaration loop.
  const refreshOnImportRef = useRef<() => void>(() => {});

  // Listen for import progress + result events
  useEffect(() => {
    const unsub = remoteWS.onMessage(msg => {
      if (msg.type !== 'event' || !msg.data) return;
      if (msg.action === 'eagle_batch_import_progress') {
        const d = msg.data as { index?: number; total?: number };
        setImportState(prev => prev.stage === 'importing'
          ? { ...prev, progress: d.index ?? prev.progress }
          : prev);
      } else if (msg.action === 'eagle_batch_import_result') {
        const d = msg.data as { processed?: number; failed?: number; total?: number };
        setImportState({
          stage: 'done',
          processed: d.processed ?? 0,
          failed: d.failed ?? 0,
          total: d.total ?? 0,
        });
        refreshOnImportRef.current();
      }
    });
    return unsub;
  }, []);

  // Single-item trash (P2.6) — confirms in caller, removes optimistically
  const trashItemOptimistic = useCallback((itemId: string) => {
    setItems(prev => prev.filter(it => it.id !== itemId));
    setTotalItems(prev => Math.max(0, prev - 1));
    setDetailItem(prev => prev?.id === itemId ? null : prev);
    remoteWS.trashItem(itemId);
  }, []);

  // Batch trash — fires N trash commands, removes optimistically from items[]
  const batchTrash = useCallback(() => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setItems(prev => prev.filter(it => !selectedIds.has(it.id)));
    setTotalItems(prev => Math.max(0, prev - ids.length));
    for (const id of ids) remoteWS.trashItem(id);
    exitSelectMode();
  }, [selectedIds, exitSelectMode]);

  // Build the lightbox image array for all current items and open at the
  // tapped one. thumbRef is only attached to the active image — the others
  // have no hero anchor and the close animation will simply fade for them.
  const openLightboxAt = useCallback(
    // thumbRef is AnimatedRef<any> to match Bluesky's ImageSource declared
    // shape; the underlying ref points to an Animated.View hosting the thumb.
    (targetItem: LibraryItem, thumbRef: AnimatedRef<any>) => {
      const idx = items.findIndex(i => i.id === targetItem.id);
      if (idx < 0) return;
      const lbImages: LbImageSource[] = items.map((it, i) => {
        const dims = it.width && it.height
          ? { width: it.width, height: it.height }
          : null;
        const fullUri = fileServerUrl
          ? `${fileServerUrl}/full/${it.id}`
          : (thumbs[it.id] ?? '');
        const thumbUri = fileServerUrl
          ? `${fileServerUrl}/thumb/${it.id}`
          : (thumbs[it.id] ?? '');
        return {
          uri: fullUri,
          dimensions: dims,
          thumbUri,
          thumbDimensions: dims,
          thumbRect: null,
          thumbRef: i === idx ? thumbRef : null,
          thumbBorderRadius: 12,
        };
      });
      openLightboxControl({
        images: lbImages,
        index: idx,
        // When the lightbox closes we land back in the DetailModal — but if
        // the user swiped to a different image, the modal would otherwise
        // still show the originally-tapped item. Mirror the lightbox's final
        // page into detailItem so the modal stays in sync. Use itemsRef so a
        // stale items[] closure doesn't shadow a more recent state update.
        onClose: (finalIndex: number) => {
          const tgt = itemsRef.current[finalIndex];
          if (tgt) setDetailItem(tgt);
        },
      });
    },
    [items, fileServerUrl, thumbs, openLightboxControl],
  );

  // Pending rollback listeners — each updateItemOptimistic registers one on
  // the global remoteWS singleton and unsubs itself when the server's
  // eagle_update_result lands. If the user navigates away or backgrounds the
  // app before the response arrives, those listeners would leak indefinitely
  // and hold stale state setters. Flush them all on unmount.
  const pendingUpdateUnsubsRef = useRef<Array<() => void>>([]);
  useEffect(() => {
    return () => {
      for (const u of pendingUpdateUnsubsRef.current) u();
      pendingUpdateUnsubsRef.current = [];
    };
  }, []);

  // Optimistic item update — patches items[] immediately, fires WS command,
  // rolls back on eagle_update_result failure. Used by lightbox rating bar
  // (P2.2) and DetailModal inline editing (P2.3).
  const updateItemOptimistic = useCallback(
    (itemId: string, fields: Partial<LibraryItem>) => {
      let previousFields: Partial<LibraryItem> | null = null;
      setItems(prev => prev.map(it => {
        if (it.id !== itemId) return it;
        previousFields = {};
        for (const k of Object.keys(fields) as (keyof LibraryItem)[]) {
          (previousFields as any)[k] = it[k];
        }
        return { ...it, ...fields };
      }));
      // Mirror into detailItem so the open DetailModal reflects the change.
      setDetailItem(prev => prev && prev.id === itemId ? { ...prev, ...fields } : prev);
      remoteWS.updateItem(itemId, fields);

      // Roll back if server rejects. Single-use listener; idempotent if multiple
      // updates race because we key by itemId + the patched fields snapshot.
      const unsub = remoteWS.onMessage(msg => {
        if (msg.type !== 'event' || msg.action !== 'eagle_update_result' || !msg.data) return;
        const d = msg.data as { itemId?: string; success?: boolean };
        if (d.itemId !== itemId) return;
        unsub();
        pendingUpdateUnsubsRef.current = pendingUpdateUnsubsRef.current.filter(u => u !== unsub);
        if (d.success === false && previousFields) {
          setItems(prev => prev.map(it =>
            it.id === itemId ? { ...it, ...(previousFields as Partial<LibraryItem>) } : it
          ));
          setDetailItem(prev => prev && prev.id === itemId
            ? { ...prev, ...(previousFields as Partial<LibraryItem>) } : prev);
        }
      });
      pendingUpdateUnsubsRef.current.push(unsub);
    },
    []
  );

  // Probe file server URLs in parallel — first 200 wins.
  // Serial probing was a problem when desktop had 192.168.x + 10.x + Tailscale
  // 100.x interfaces: the LAN URLs were tried first and timed out (2s each)
  // before the Tailscale URL (the only routable one over the tailnet) got a
  // turn, so users on tailnet sat 4–6s with no file server URL.
  const probeFileServers = useCallback(async (urls: string[]) => {
    // Dev-only: include the USB ADB-reverse path so desktop's LAN file_server
    // is reachable even when phone WiFi and PC aren't on the same segment.
    // Stripped from prod bundles by RN's __DEV__ dead-code elimination.
    if (__DEV__) {
      const dev = 'http://localhost:62161';
      if (!urls.includes(dev)) urls = [dev, ...urls];
    }
    if (urls.length === 0) return;
    try {
      const winner = await Promise.any(
        urls.map(async (url) => {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 2500);
          try {
            const r = await fetch(`${url}/health`, { signal: c.signal });
            if (!r.ok) throw new Error(`status ${r.status}`);
            return url;
          } finally {
            clearTimeout(t);
          }
        })
      );
      setFileServerUrl(winner);
      remoteWS.setTransport('lan');
    } catch {
      // all probes failed — leave fileServerUrl null so WS path kicks in
      remoteWS.setTransport('relay');
    }
  }, []);

  // Message listener
  useEffect(() => {
    const unsub = remoteWS.onMessage((msg: RemoteMessage) => {
      if (!msg.data) return;
      if (msg.type === 'status') {
        const d = msg.data as { fileServerUrls?: string[] };
        if (d.fileServerUrls?.length) probeFileServers(d.fileServerUrls);
        else remoteWS.setTransport('relay');   // no LAN candidates → relay
        return;
      }
      if (msg.type !== 'event') return;

      if (msg.action === 'file_server') {
        const d = msg.data as { url?: string };
        if (d.url) probeFileServers([d.url]);
      }
      if (msg.action === 'eagle_folders') {
        const d = msg.data as { folders?: LibraryFolder[] };
        if (d.folders) setFolders(d.folders);
      }
      if (msg.action === 'eagle_tags') {
        const d = msg.data as { tags?: { name: string; count: number }[] };
        if (d.tags) setAllTags(d.tags);
      }
      if (msg.action === 'eagle_search' || msg.action === 'eagle_recent' || msg.action === 'eagle_items') {
        setLoading(false); setLoadingMore(false);
        const d = msg.data as {
          items?: LibraryItem[]; total?: number; offset?: number; error?: string;
        };
        if (d.error) { setError(d.error); return; }
        setError('');
        setTotalItems(d.total ?? 0);
        const off = d.offset ?? 0;
        const newItems = d.items || [];
        if (off === 0) setItems(newItems);
        else setItems(prev => {
          const seen = new Set(prev.map(i => i.id));
          return [...prev, ...newItems.filter(i => !seen.has(i.id))];
        });
      }
      if (msg.action === 'eagle_pose_search') {
        setLoading(false);
        const d = msg.data as { success?: boolean; message?: string; items?: LibraryItem[] };
        if (!d.success) { setError(d.message || 'Pose search failed'); return; }
        setError('');
        const poseItems = d.items || [];
        setItems(poseItems);
        setTotalItems(poseItems.length);
      }
      if (msg.action === 'eagle_thumbnail') {
        const d = msg.data as { itemId?: string; data?: string; mime?: string };
        if (d.itemId && d.data) {
          setThumbs(prev => ({ ...prev, [d.itemId!]: `data:${d.mime || 'image/png'};base64,${d.data}` }));
        }
      }
      // Folder mutations (P2.5): refetch folder list when the server confirms
      if (msg.action === 'eagle_folder_created' || msg.action === 'eagle_folder_renamed') {
        const d = msg.data as { success?: boolean };
        if (d.success) remoteWS.requestFolders();
      }
    });
    return unsub;
  }, []);

  // LAN thumbs are computed inline in renderCell from fileServerUrl + item.id —
  // no need to mirror them into thumbs state. Previously we ran setThumbs with a
  // full {...prev, ...batch} spread every time items changed (i.e. every page
  // load), which rebuilt renderCell, invalidated FlashList, and triggered cell
  // recycling that flashed images in/out as the user scrolled.

  // WAN thumbnails: viewport-aware via onViewableItemsChanged (see FlashList below).
  // Only items actually scrolled into view get a thumb request — avoids hammering
  // the desktop with 200 Pillow+base64 jobs when the user only scrolls 20 cells.
  // Request thumbs for visible items still missing one. thumbRequested holds a
  // last-request timestamp, not a permanent flag: if a response is lost (relay
  // flap / dropped base64) the item is retried after THUMB_RETRY_MS instead of
  // staying blank forever.
  const requestMissingThumbs = useCallback(() => {
    if (fileServerUrl) return; // LAN serves thumbs directly by URL, no request needed
    const now = Date.now();
    for (const id of visibleIds.current) {
      if (thumbsRef.current[id]) continue;                        // already have it
      const last = thumbRequested.current.get(id);
      if (last != null && now - last < THUMB_RETRY_MS) continue;  // in flight / recently tried
      thumbRequested.current.set(id, now);
      remoteWS.requestThumbnail(id);
    }
  }, [fileServerUrl]);

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: { item: LibraryItem }[] }) => {
      visibleIds.current = new Set(
        viewableItems.map(v => v.item?.id).filter((id): id is string => !!id)
      );
      requestMissingThumbs();
    },
    [requestMissingThumbs]
  );
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  // Self-heal: periodically retry visible thumbs whose response never arrived.
  // Without it a single dropped reply leaves the cell blank until next search.
  useEffect(() => {
    if (fileServerUrl) return;
    const t = setInterval(requestMissingThumbs, 4000);
    return () => clearInterval(t);
  }, [fileServerUrl, requestMissingThumbs]);

  // Auto-connect to relay when this tab is focused. Lifted here from the
  // (deleted) workshop tab — without it, remoteWS.connect() is never called
  // and the gallery sits forever on "桌面端未连接".
  useFocusEffect(useCallback(() => {
    (async () => {
      if (await isLoggedIn()) remoteWS.connect();
    })();
  }, []));

  // Load once, then cache. Tab screens stay mounted (expo-router keeps them
  // alive across tab switches), so we only fetch on the FIRST focus — returning
  // to the tab keeps the cached items + scroll position. A ref guard avoids the
  // stale-closure trap where `items.length` read the value captured when
  // `connected` flipped (always 0 → it reloaded on every focus). Freshness is
  // handled by pull-to-refresh, the import-finished refresh, and the reconnect
  // effect below.
  const hasLoadedRef = useRef(false);
  useFocusEffect(useCallback(() => {
    if (!connected) return;
    if (!fileServerUrl) remoteWS.requestStatus();
    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true;
      doSearch({});
      remoteWS.requestFolders();
      remoteWS.requestTags();
    }
  }, [connected]));

  // Execute search with given params (replaces fetchImages)
  const doSearch = useCallback((params: {
    keyword?: string; tags?: string[]; rating?: number; folderId?: string;
  }) => {
    setLoading(true); setError('');
    setItems([]); setTotalItems(0);
    setThumbs({}); thumbRequested.current.clear();
    lanFallbackRef.current.clear();   // don't carry LAN→relay fallbacks across searches
    searchParamsRef.current = {
      keyword: params.keyword || '',
      tags: params.tags || [],
      rating: params.rating || 0,
      folderId: params.folderId || '',
    };
    remoteWS.requestSearch({ ...params, offset: 0, limit: PAGE_SIZE });
  }, []);

  // Wire the import-finished refresh now that doSearch exists.
  refreshOnImportRef.current = () => doSearch(searchParamsRef.current);

  // Reconnect refresh — if the relay dropped and recovered AFTER we'd already
  // loaded once, resync the current search to catch desktop-side changes missed
  // while offline. (First-ever connect is handled by the load-once focus effect,
  // gated by hasLoadedRef, so this won't double-fire on startup.)
  const wasConnectedRef = useRef(false);
  useEffect(() => {
    if (connected && !wasConnectedRef.current && hasLoadedRef.current) {
      doSearch(searchParamsRef.current);
    }
    wasConnectedRef.current = connected;
  }, [connected, doSearch]);

  // Debounced search on query change
  const onSearchChange = useCallback((text: string) => {
    setSearchQuery(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      doSearch({
        keyword: text,
        tags: activeTags,
        rating: activeRating,
        folderId: activeFolder?.id,
      });
    }, 400);
  }, [activeTags, activeRating, activeFolder, doSearch]);

  // Trigger search when filters change (not text — text has its own debounce)
  const applyFilters = useCallback((
    folder: LibraryFolder | null, tags: string[], rating: number,
  ) => {
    setActiveFolder(folder);
    setActiveTags(tags);
    setActiveRating(rating);
    doSearch({
      keyword: searchQuery,
      tags,
      rating,
      folderId: folder?.id,
    });
  }, [searchQuery, doSearch]);

  const selectFolder = (f: LibraryFolder | null) => {
    setFilterOpen(false);
    applyFilters(f, activeTags, activeRating);
  };

  const toggleTag = (tag: string) => {
    const next = activeTags.includes(tag)
      ? activeTags.filter(t => t !== tag)
      : [...activeTags, tag];
    setTagPickerOpen(false);
    applyFilters(activeFolder, next, activeRating);
  };

  const setRating = (r: number) => {
    const next = r === activeRating ? 0 : r; // toggle off if same
    applyFilters(activeFolder, activeTags, next);
  };

  const clearAllFilters = () => {
    setSearchQuery('');
    setFilterOpen(false);
    setTagPickerOpen(false);
    applyFilters(null, [], 0);
  };

  const hasAnyFilter = !!(searchQuery || activeTags.length || activeRating || activeFolder);

  // Summary string for the combined tag+rating filter chip. Falls back to
  // "筛选" when neither dimension is set so the chip stays compact at rest.
  const filterSummaryActive = activeTags.length > 0 || activeRating > 0;
  const filterSummary = filterSummaryActive
    ? [
        activeTags.length ? activeTags.join(', ') : null,
        activeRating > 0 ? `${activeRating}+` : null,
      ].filter(Boolean).join(' · ')
    : '筛选';

  const doPoseSearch = useCallback((refItemId: string) => {
    setDetailItem(null);
    setSearchQuery('');
    setActiveFolder(null);
    setActiveTags([]);
    setActiveRating(0);
    setLoading(true); setError('');
    setItems([]); setTotalItems(0);
    setThumbs({}); thumbRequested.current.clear();
    lanFallbackRef.current.clear();   // don't carry LAN→relay fallbacks across searches
    searchParamsRef.current = { keyword: '', tags: [], rating: 0, folderId: '' };
    remoteWS.requestPoseSearch({ refItemId });
  }, []);

  // Refs for loadMore stale closure fix
  const itemsRef = useRef(items);
  const totalRef = useRef(totalItems);
  const loadingMoreRef = useRef(loadingMore);
  itemsRef.current = items;
  totalRef.current = totalItems;
  loadingMoreRef.current = loadingMore;

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || itemsRef.current.length >= totalRef.current) return;
    setLoadingMore(true);
    remoteWS.requestSearch({
      ...searchParamsRef.current,
      offset: itemsRef.current.length,
      limit: PAGE_SIZE,
    });
  }, []);

  // thumbsRef so renderCell can look up WAN thumbnails without taking `thumbs`
  // as a dep (which would re-create renderCell on every base64 arrival and
  // invalidate the whole FlashList).
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;
  const [thumbsVersion, setThumbsVersion] = useState(0);
  useEffect(() => { setThumbsVersion(v => v + 1); }, [thumbs]);

  // Per-item LAN→relay fallback: ids whose LAN thumb URL failed to load are
  // switched to a relay-delivered base64 thumb instead.
  const lanFallbackRef = useRef<Set<string>>(new Set());

  // Layered recovery when a cell's image fails to load. Rate-limited to one
  // retry per THUMB_RETRY_MS per id so a persistently bad payload can't loop:
  //   - LAN thumb failed          → fall back to a relay thumbnail for this item
  //   - relay thumb failed/corrupt → drop it and re-request (self-heal also retries)
  const onThumbError = useCallback((id: string) => {
    const last = thumbRequested.current.get(id);
    if (last != null && Date.now() - last < THUMB_RETRY_MS) return;
    if (fileServerUrl != null && !lanFallbackRef.current.has(id)) {
      lanFallbackRef.current.add(id);
    } else {
      setThumbs(prev => {
        if (!(id in prev)) return prev;
        const n = { ...prev }; delete n[id]; return n;
      });
    }
    thumbRequested.current.set(id, Date.now());
    remoteWS.requestThumbnail(id);
  }, [fileServerUrl]);

  const renderCell = useCallback(({ item }: { item: LibraryItem }) => {
    const thumbUrl = (fileServerUrl != null && !lanFallbackRef.current.has(item.id))
      ? `${fileServerUrl}/thumb/${item.id}`
      : thumbsRef.current[item.id];
    return (
      <MemoCell
        item={item}
        thumb={thumbUrl}
        onThumbError={onThumbError}
        selectMode={selectMode}
        selected={selectedIds.has(item.id)}
        onPress={() => {
          if (selectMode) {
            toggleSelected(item.id);
          } else {
            // Warm the disk cache so by the time the user taps "view large"
            // in the detail modal, the lightbox can render the full image
            // without a visible placeholder→full transition.
            if (fileServerUrl) {
              Image.prefetch(`${fileServerUrl}/full/${item.id}`, 'disk');
            }
            setDetailItem(item);
          }
        }}
        onLongPress={() => {
          if (!selectMode) enterSelectMode(item.id);
        }}
      />
    );
  // thumbsVersion is included so WAN base64 arrivals trigger a re-render of
  // cells (otherwise they'd be stuck on placeholder until another state change).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileServerUrl, selectMode, selectedIds, toggleSelected, enterSelectMode, thumbsVersion, onThumbError]);

  if (!connected) {
    const isConnecting = wsState === 'connecting';
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg.canvas }}>
        <YStack flex={1} justifyContent="center" alignItems="center"
          paddingHorizontal="$5" gap="$3">
          <YStack width={80} height={80} borderRadius={40}
            backgroundColor={colors.bg.thumb}
            justifyContent="center" alignItems="center">
            <Unplug size={36} color={colors.text.muted} />
          </YStack>
          <YStack alignItems="center" gap={6}>
            <Text color={colors.text.primary} fontSize={17} fontWeight="600">
              桌面端未连接
            </Text>
            <Text color={colors.text.tertiary} fontSize={13} textAlign="center" lineHeight={20}>
              {isConnecting ? '正在连接…' : '请在电脑上打开 Nephele Workshop'}
            </Text>
          </YStack>
          <Pressable
            onPress={() => { if (!isConnecting) remoteWS.connect(); }}
            disabled={isConnecting}
            hitSlop={6}
          >
            <XStack
              marginTop={12}
              backgroundColor={isConnecting ? colors.bg.subtle : colors.brand.primary}
              paddingHorizontal={20} paddingVertical={10}
              borderRadius={20}
              alignItems="center" gap={8}
            >
              {isConnecting && <Spinner size="small" color={colors.text.tertiary} />}
              <Text fontSize={14} fontWeight="600"
                color={isConnecting ? colors.text.tertiary : colors.bg.canvas}>
                {isConnecting ? '连接中' : '重新连接'}
              </Text>
            </XStack>
          </Pressable>
        </YStack>
      </SafeAreaView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.canvas }}>
      {/* Frosted collapsing header overlay — the list scrolls UP behind it
          (its paddingTop reserves the expanded header height). Same frosted
          glass as the tab bar; search row folds away on scroll, chips stay. */}
      <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 }}>
        {/* iOS: real system blur (UIVisualEffectView) — true frosted glass,
            zero crash. Android: NO crash-free backdrop-blur primitive exists
            (RenderEffect blurs a view's own content, not what's behind it;
            the only backdrop path is dimezis' per-frame snapshot, which
            crashes + janks behind a recycling masonry list). So Android gets
            a multi-layer faux-glass: low top alpha lets images bleed through,
            high bottom alpha keeps chip/text contrast, + a top highlight rim
            and a bottom hairline to read as a glass edge. */}
        {Platform.OS === 'ios' ? (
          <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
        ) : (
          <ExpoLinearGradient
            colors={['rgba(58,52,90,0.55)', 'rgba(42,38,70,0.86)', 'rgba(36,34,60,0.96)']}
            locations={[0, 0.55, 1]}
            start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        )}
        <View style={{
          paddingTop: insets.top,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: 'rgba(255,255,255,0.07)',
        }}>
          {/* top highlight rim — a 1px lit edge sells the "glass" read */}
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.06)' }} pointerEvents="none" />
      {selectMode ? (
        /* Select-mode header: replaces search/actions row entirely while
            multi-select is active. Filter chips + count row are also
            suppressed below so the chrome reads as a focused batch surface
            (iOS Photos / Pinterest pattern). */
        <XStack paddingHorizontal={16} paddingTop={10} paddingBottom={8}
          height={56} alignItems="center" gap={14}>
          <Pressable onPress={exitSelectMode} hitSlop={8}>
            <X size={22} color={colors.text.secondary} />
          </Pressable>
          <Text flex={1} fontSize={16} fontWeight="600" color={colors.text.primary}>
            {selectedIds.size > 0 ? `已选 ${selectedIds.size} 项` : '请选择'}
          </Text>
        </XStack>
      ) : (
        /* Normal header — search bar. Collapses 1:1 with scroll (height→0)
            so it "rolls up" with the content; the chips row below stays. */
        <Animated.View style={searchCollapseStyle}>
        <XStack paddingHorizontal={16} paddingTop={14} paddingBottom={12} gap={14} alignItems="center">
          <XStack flex={1} backgroundColor="transparent" borderRadius={8} paddingLeft={12}
            alignItems="center" borderWidth={1} overflow="hidden"
            borderColor={(searchFocused || searchQuery) ? colors.brand.primary : colors.border.default}
            height={44}>
            {/* Glass depth — subtle lighter-top gradient so the field reads as
                "raised" on the dark canvas (shadows don't show on dark). */}
            <ExpoLinearGradient colors={['#332E52', '#27233F']}
              start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
            <Search size={19} color={colors.brand.primary} />
            <Input ref={searchInputRef} flex={1} placeholder="搜索素材..." value={searchQuery}
              onChangeText={onSearchChange} backgroundColor="transparent" borderWidth={0}
              color={colors.text.primary} fontSize={14} height={38}
              placeholderTextColor={colors.text.muted} returnKeyType="search"
              onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} />
            {searchQuery ? (
              <Pressable onPress={() => onSearchChange('')} style={{ paddingRight: 10 }} hitSlop={6}>
                <CircleX size={16} color={colors.text.faint} />
              </Pressable>
            ) : null}
          </XStack>
          {/* Cancel-on-focus (tmui x-search showCancel): slides in while the
              search is focused; clears + dismisses the keyboard. */}
          {searchFocused && (
            <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
              <Pressable onPress={() => { onSearchChange(''); Keyboard.dismiss(); }} hitSlop={8}>
                <Text fontSize={14} color={colors.brand.primary}>取消</Text>
              </Pressable>
            </Animated.View>
          )}
        </XStack>
        </Animated.View>
      )}

      {/* Filter row — folder chip + combined filter chip (tag + rating live
          in TagPickerSheet now); count moved inline to the right edge.
          Hidden in select mode to keep the chrome focused on the batch task. */}
      {!selectMode && (
      <XStack paddingHorizontal={16} paddingBottom={14} alignItems="center" gap={10}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 1, flexShrink: 1 }}
          contentContainerStyle={{ gap: 10, alignItems: 'center' }}>
          <Pressable onPress={() => setFilterOpen(true)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <FilterChip label={activeFolder ? activeFolder.name : '文件夹'}
              active={!!activeFolder} icon={Folder} />
          </Pressable>
          <Pressable onPress={() => setTagPickerOpen(true)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <FilterChip label={filterSummary}
              active={filterSummaryActive} icon={SlidersHorizontal} />
          </Pressable>
          {hasAnyFilter && (
            <Pressable onPress={clearAllFilters} hitSlop={4}>
              <XStack alignItems="center" gap={4} paddingHorizontal={6} paddingVertical={5}>
                <X size={14} color={colors.text.tertiary} />
                <Text fontSize={12} color={colors.text.tertiary}>清除</Text>
              </XStack>
            </Pressable>
          )}
        </ScrollView>
        {totalItems > 0 && (
          <Text fontSize={12} fontWeight="500" color={colors.text.tertiary}>{totalItems.toLocaleString()} 项</Text>
        )}
      </XStack>
      )}

      {error ? (
        <YStack marginHorizontal="$4" marginBottom="$2" backgroundColor={colors.bg.surface}
          borderRadius="$3" padding="$2.5">
          <Text color={colors.status.error} fontSize={13}>{error}</Text>
        </YStack>
      ) : null}
        </View>
      </Animated.View>

      {loading ? (
        <SkeletonGrid topPad={listTopPad} />
      ) : (
        <AnimatedFlashList
          data={items}
          numColumns={2}
          masonry
          optimizeItemArrangement
          renderItem={renderCell}
          // Without keyExtractor, FlashList falls back to index as the React
          // key. Index keys break when items grows (loadMore append), causing
          // cells to misidentify which item they're rendering after recycle.
          keyExtractor={(item: LibraryItem) => item.id}
          contentContainerStyle={{ paddingHorizontal: PAD, paddingTop: listTopPad, paddingBottom: TAB_BAR_CLEARANCE }}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          // Pull-to-refresh: only show the native spinner when we already have
          // data — initial / filter-change loads route through SkeletonGrid
          // instead (the list is unmounted then, RefreshControl wouldn't render).
          refreshing={loading && items.length > 0}
          onRefresh={() => doSearch(searchParamsRef.current)}
          ListEmptyComponent={
            <YStack paddingTop={60} alignItems="center" gap={12} paddingHorizontal="$5">
              <YStack width={72} height={72} borderRadius={36}
                backgroundColor={colors.bg.thumb}
                justifyContent="center" alignItems="center">
                <Images size={32} color={colors.text.muted} />
              </YStack>
              {hasAnyFilter ? (
                <>
                  <Text color={colors.text.primary} fontSize={16} fontWeight="600">
                    没有匹配的图片
                  </Text>
                  <Text color={colors.text.tertiary} fontSize={13} textAlign="center">
                    换个筛选条件再试试
                  </Text>
                  <Pressable onPress={clearAllFilters} hitSlop={6} style={{ marginTop: 4 }}>
                    <Text color={colors.brand.primary} fontSize={14} fontWeight="600">
                      清除筛选
                    </Text>
                  </Pressable>
                </>
              ) : activeFolder ? (
                <>
                  <Text color={colors.text.primary} fontSize={16} fontWeight="600">
                    这个文件夹是空的
                  </Text>
                  <Text color={colors.text.tertiary} fontSize={13} textAlign="center">
                    切到其他文件夹或导入图片
                  </Text>
                </>
              ) : (
                <>
                  <Text color={colors.text.primary} fontSize={16} fontWeight="600">
                    素材库还没图
                  </Text>
                  <Text color={colors.text.tertiary} fontSize={13} textAlign="center">
                    从手机相册导入开始
                  </Text>
                  <Pressable onPress={importFromGallery} hitSlop={6} style={{ marginTop: 4 }}>
                    <XStack alignItems="center" gap={6}
                      backgroundColor={colors.brand.primary}
                      paddingHorizontal={16} paddingVertical={8}
                      borderRadius={20}>
                      <ImagePlus size={16} color={colors.bg.canvas} />
                      <Text color={colors.bg.canvas} fontSize={14} fontWeight="600">导入图片</Text>
                    </XStack>
                  </Pressable>
                </>
              )}
            </YStack>
          }
          ListFooterComponent={
            loadingMore ? (
              <YStack padding="$3" alignItems="center"><Spinner size="small" color={colors.brand.primary} /></YStack>
            ) : items.length > 0 && items.length >= totalItems ? (
              <YStack padding="$3" alignItems="center"><Text color={colors.text.faint} fontSize={12}>已加载全部</Text></YStack>
            ) : null
          }
        />
      )}

      {/* Folder filter sheet */}
      <FolderFilterSheet
        visible={filterOpen}
        folders={folders}
        activeId={activeFolder?.id ?? null}
        onSelect={selectFolder}
        onClose={() => setFilterOpen(false)}
        onCreate={() => setFolderDialog({ mode: 'create' })}
        onRequestRename={(f) => setFolderDialog({ mode: 'rename', folder: f })}
      />

      {/* Folder create/rename dialog */}
      <FolderNameDialog
        state={folderDialog}
        onClose={() => setFolderDialog(null)}
        onSubmit={(name) => {
          if (!folderDialog) return;
          if (folderDialog.mode === 'create') {
            remoteWS.createFolder(name);
          } else {
            remoteWS.renameFolder(folderDialog.folder.id, name);
          }
          setFolderDialog(null);
        }}
      />

      {/* Filter sheet (tag + rating) */}
      <TagPickerSheet
        visible={tagPickerOpen}
        tags={allTags}
        activeTags={activeTags}
        onToggle={toggleTag}
        rating={activeRating}
        onSetRating={setRating}
        onClose={() => setTagPickerOpen(false)}
      />

      {/* Detail Modal — items + onIndexChange let the modal page horizontally
          through the gallery in lock-step with the lightbox: swipe in either
          surface updates detailItem, the other surface follows. */}
      <DetailModal
        item={detailItem}
        items={items}
        getThumb={(id) => (fileServerUrl ? `${fileServerUrl}/thumb/${id}` : thumbs[id])}
        onIndexChange={(i) => {
          const tgt = itemsRef.current[i];
          if (tgt) setDetailItem(tgt);
        }}
        onClose={() => setDetailItem(null)}
        onOpenLightbox={openLightboxAt}
        onUpdateItem={updateItemOptimistic}
        onTrash={trashItemOptimistic}
        onPoseSearch={doPoseSearch} />

      {/* Lightbox mounts globally in app/_layout.tsx (overlay); opened via
          useLightboxControls().openLightbox(...). */}

      {/* Batch action bar — shown only in select mode with ≥1 item picked */}
      {selectMode && selectedIds.size > 0 && (
        <BatchActionBar
          count={selectedIds.size}
          onSetStar={batchSetStar}
          onAddTag={batchAddTag}
          onTrash={batchTrash}
        />
      )}

      {/* Import source picker (branded action sheet, replaces native Alert) */}
      <AuraActionSheet
        visible={importSheetVisible}
        title="添加素材"
        onClose={() => setImportSheetVisible(false)}
        options={[
          { label: '拍照', icon: Camera, onPress: importFromCamera },
          { label: '从相册选', icon: ImageIcon, onPress: importFromGallery },
        ]}
      />

      {/* Import progress modal */}
      <ImportProgressModal
        state={importState}
        onDismiss={() => setImportState({ stage: 'idle' })}
      />
    </View>
  );
}

// --- Folder filter bottom sheet ---

// Walk the Eagle folder tree depth-first into a flat row list, tagging each
// row with its depth so the renderer can indent children without losing the
// "every folder is one tap" property the previous flat API gave users. We
// don't do real drill-down here — folder search already recurses into
// children server-side (lib.get_items_in_folder(..., recursive=True)), so
// selecting any visible row pulls the right items regardless of depth.
type FolderRow = LibraryFolder & { depth: number };
function flattenFolderTree(folders: LibraryFolder[], depth = 0): FolderRow[] {
  const out: FolderRow[] = [];
  for (const f of folders) {
    out.push({ ...f, depth });
    if (f.children && f.children.length) {
      out.push(...flattenFolderTree(f.children, depth + 1));
    }
  }
  return out;
}

function FolderFilterSheet({ visible, folders, activeId, onSelect, onClose,
                             onCreate, onRequestRename }: {
  visible: boolean; folders: LibraryFolder[];
  activeId: string | null;
  onSelect: (f: LibraryFolder | null) => void;
  onClose: () => void;
  onCreate?: () => void;
  onRequestRename?: (f: LibraryFolder) => void;
}) {
  const insets = useSafeAreaInsets();
  // Flatten on each render — folders is small (≤ hundreds) so memoization
  // would mostly add noise. If we ever see real cost, wrap with useMemo.
  const rows = visible ? flattenFolderTree(folders) : [];
  if (!visible) return null;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: colors.overlay.scrim }} onPress={onClose}>
        <Pressable
          style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            backgroundColor: colors.bg.surface,
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            maxHeight: '70%',
            paddingBottom: insets.bottom || 16,
          }}
          onPress={e => e.stopPropagation()}
        >
          <YStack alignItems="center" paddingVertical={10}>
            <YStack width={36} height={4} borderRadius={2} backgroundColor={colors.text.muted} />
          </YStack>
          <XStack paddingHorizontal={16} marginBottom={8} alignItems="center" justifyContent="space-between">
            <Text fontSize={17} fontWeight="600" color={colors.text.primary}>按文件夹筛选</Text>
            {onCreate && (
              <Pressable onPress={onCreate} hitSlop={6}>
                <XStack alignItems="center" gap={4}>
                  <FolderPlus size={18} color={colors.brand.primary} />
                  <Text fontSize={13} color={colors.brand.primary} fontWeight="600">新建</Text>
                </XStack>
              </Pressable>
            )}
          </XStack>

          <FlatList
            style={{ maxHeight: SCREEN_H * 0.55 }}
            data={rows}
            keyExtractor={f => f.id}
            initialNumToRender={20}
            maxToRenderPerBatch={15}
            getItemLayout={(_, i) => ({ length: 44, offset: 44 * i, index: i })}
            ListHeaderComponent={
              <Pressable onPress={() => onSelect(null)}>
                <XStack paddingHorizontal={16} paddingVertical={12} alignItems="center" gap={12}
                  backgroundColor={activeId === null ? colors.brand.softer : 'transparent'}>
                  <Images size={20}
                    color={activeId === null ? colors.brand.primary : colors.text.tertiary} />
                  <Text flex={1} fontSize={15} color={activeId === null ? colors.brand.primary : colors.text.primary}
                    fontWeight={activeId === null ? '600' : '400'}>全部图片</Text>
                  {activeId === null && <Check size={18} color={colors.brand.primary} />}
                </XStack>
              </Pressable>
            }
            ListEmptyComponent={
              <YStack paddingVertical={32} paddingHorizontal={24} alignItems="center">
                <Text fontSize={13} color={colors.text.tertiary} textAlign="center">
                  这个 Eagle 库里还没有文件夹
                </Text>
              </YStack>
            }
            renderItem={({ item: f }) => {
              const isActive = f.id === activeId;
              const imgCount = f.imageCount ?? f.count ?? 0;
              // 8px dot mirrors desktop EagleFolderTree.qml. Eagle's folder
              // colors are plain CSS names (red/orange/yellow/green/blue/
              // purple/pink/aqua) so they slot straight into RN style; fall
              // back to the brand purple when the folder has no color set.
              const dotColor = f.color || colors.brand.primary;
              return (
                <Pressable onPress={() => onSelect(f)}
                  onLongPress={onRequestRename ? () => onRequestRename(f) : undefined}
                  delayLongPress={400}>
                  <XStack paddingVertical={12} alignItems="center" gap={10}
                    paddingLeft={16 + f.depth * 18}
                    paddingRight={16}
                    backgroundColor={isActive ? colors.brand.softer : 'transparent'}>
                    <YStack width={8} height={8} borderRadius={4} backgroundColor={dotColor} />
                    <Text flex={1} fontSize={15}
                      color={isActive ? colors.brand.primary : colors.text.primary}
                      fontWeight={isActive ? '600' : '400'}
                      numberOfLines={1}>{f.name}</Text>
                    {imgCount > 0 && (
                      <Text fontSize={12} color={colors.text.muted}>{imgCount}</Text>
                    )}
                    {isActive && <Check size={18} color={colors.brand.primary} />}
                  </XStack>
                </Pressable>
              );
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// --- Filter Chip ---

function FilterChip({ label, active, icon: Icon }: { label: string; active: boolean; icon: LucideIcon }) {
  return (
    <XStack backgroundColor={active ? colors.brand.primary : colors.bg.surface}
      borderRadius={16} paddingHorizontal={13} paddingVertical={7}
      alignItems="center" gap={5}>
      <Icon size={15} color={active ? colors.bg.canvas : colors.text.tertiary} />
      <Text fontSize={13} fontWeight={active ? '600' : '500'}
        color={active ? colors.bg.canvas : colors.text.secondary} numberOfLines={1} maxWidth={120}>
        {label}
      </Text>
    </XStack>
  );
}

// --- Tag Picker Sheet ---

function TagPickerSheet({ visible, tags, activeTags, onToggle,
                          rating, onSetRating, onClose }: {
  visible: boolean;
  tags: { name: string; count: number }[];
  activeTags: string[];
  onToggle: (tag: string) => void;
  rating: number;
  onSetRating: (r: number) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  if (!visible) return null;

  const filtered = query
    ? tags.filter(t => t.name.toLowerCase().includes(query.toLowerCase()))
    : tags;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: colors.overlay.scrim }} onPress={onClose}>
        <Pressable
          style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            backgroundColor: colors.bg.surface,
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            maxHeight: '78%',
            paddingBottom: insets.bottom || 16,
          }}
          onPress={e => e.stopPropagation()}
        >
          <YStack alignItems="center" paddingVertical={10}>
            <YStack width={36} height={4} borderRadius={2} backgroundColor={colors.text.muted} />
          </YStack>
          <Text fontSize={17} fontWeight="600" color={colors.text.primary} paddingHorizontal={16} marginBottom={12}>
            筛选
          </Text>

          {/* Rating row */}
          <XStack paddingHorizontal={16} marginBottom={14} alignItems="center" gap={8}>
            <Text fontSize={13} color={colors.text.tertiary} width={32}>评分</Text>
            {[3, 4, 5].map(r => (
              <Pressable key={r} onPress={() => onSetRating(r)} hitSlop={4}>
                <XStack backgroundColor={rating === r ? colors.brand.soft : colors.bg.surface}
                  borderRadius={14} paddingHorizontal={10} paddingVertical={5}
                  alignItems="center" gap={4}
                  borderWidth={1} borderColor={rating === r ? colors.brand.primary : colors.border.default}>
                  <Star size={12}
                    color={rating === r ? colors.brand.primary : colors.text.tertiary}
                    fill={rating === r ? colors.brand.primary : 'none'} />
                  <Text fontSize={12} color={rating === r ? colors.brand.primary : colors.text.secondary}>{r}+</Text>
                </XStack>
              </Pressable>
            ))}
          </XStack>

          <YStack height={1} backgroundColor={colors.border.hairline} marginHorizontal={16} marginBottom={12} />

          <Text fontSize={13} color={colors.text.tertiary} paddingHorizontal={16} marginBottom={8}>标签</Text>

          {/* Active tags */}
          {activeTags.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 16, gap: 6, paddingBottom: 8 }}>
              {activeTags.map(t => (
                <Pressable key={t} onPress={() => onToggle(t)}>
                  <XStack backgroundColor={colors.brand.soft} borderRadius={12} paddingHorizontal={10}
                    paddingVertical={4} alignItems="center" gap={4}>
                    <Text fontSize={12} color={colors.brand.primary}>{t}</Text>
                    <X size={12} color={colors.brand.primary} />
                  </XStack>
                </Pressable>
              ))}
            </ScrollView>
          )}

          {/* Search */}
          <XStack paddingHorizontal={16} marginBottom={8}>
            <Input flex={1} placeholder="搜索标签..." value={query} onChangeText={setQuery}
              backgroundColor={colors.bg.subtle} borderWidth={0} borderRadius={8}
              color={colors.text.primary} fontSize={14} height={36} placeholderTextColor={colors.text.muted} />
          </XStack>

          <FlatList
            style={{ maxHeight: SCREEN_H * 0.45 }}
            data={filtered}
            keyExtractor={t => t.name}
            initialNumToRender={20}
            getItemLayout={(_, i) => ({ length: 44, offset: 44 * i, index: i })}
            renderItem={({ item: t }) => {
              const isActive = activeTags.includes(t.name);
              return (
                <Pressable onPress={() => onToggle(t.name)}>
                  <XStack paddingHorizontal={16} paddingVertical={12} alignItems="center" gap={12}
                    backgroundColor={isActive ? colors.brand.softer : 'transparent'}>
                    {isActive
                      ? <SquareCheck size={20} color={colors.brand.primary} />
                      : <Square size={20} color={colors.text.faint} />}
                    <Text flex={1} fontSize={15} color={isActive ? colors.brand.primary : colors.text.primary}
                      numberOfLines={1}>{t.name}</Text>
                    <Text fontSize={12} color={colors.text.muted}>{t.count}</Text>
                  </XStack>
                </Pressable>
              );
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// --- Grid Cell (memo + thumb via ref to avoid re-render cascade) ---

function CellInner({ item, thumb, selectMode, selected, onPress, onLongPress, onThumbError }: {
  item: LibraryItem; thumb?: string;
  selectMode: boolean; selected: boolean;
  onPress: () => void; onLongPress: () => void;
  onThumbError?: (id: string) => void;
}) {
  const ar = item.width && item.height ? item.width / item.height : 1;
  const h = Math.min(COL_W / ar, COL_W * 2.5);
  return (
    <Pressable
      style={({ pressed }) => ({
        marginBottom: GAP,
        marginHorizontal: GAP / 2,
        opacity: pressed ? 0.7 : 1,
      })}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
    >
      <YStack borderRadius={14} overflow="hidden">
        <YStack height={h} backgroundColor={colors.bg.thumb} justifyContent="center" alignItems="center">
          {thumb || item.blurhash
            ? <Image
                // Removed recyclingKey: it conflicts with FlashList's own cell
                // recycling — both systems were swapping state and producing the
                // "image loads, then disappears as I scroll" flicker. Source
                // string + key (= item.id via keyExtractor) is enough.
                source={thumb}
                style={{ width: '100%', height: h }}
                contentFit="cover"
                transition={0}
                cachePolicy="memory-disk"
                placeholder={item.blurhash ? { blurhash: item.blurhash } : undefined}
                onError={() => onThumbError?.(item.id)}
              />
            : <ImageIcon size={24} color={colors.text.muted} />}
          {/* Selection checkbox overlay — only visible in select mode */}
          {selectMode && (
            <YStack position="absolute" top={6} right={6}
              width={22} height={22} borderRadius={11}
              backgroundColor={selected ? colors.brand.primary : colors.overlay.onImage}
              borderWidth={1} borderColor={selected ? colors.brand.primary : colors.text.faint}
              justifyContent="center" alignItems="center">
              {selected && <Check size={14} color={colors.bg.canvas} />}
            </YStack>
          )}
        </YStack>
      </YStack>
      {/* Selection ring — absolute overlay so toggling selected state doesn't
          add 2px to the cell's layout box and shove neighbors around. */}
      {selected && (
        <YStack pointerEvents="none"
          position="absolute" top={0} left={0} right={0} bottom={0}
          borderRadius={14} borderWidth={2} borderColor={colors.brand.primary} />
      )}
    </Pressable>
  );
}

const MemoCell = memo(CellInner);

// --- Skeleton placeholder (shown while initial / refresh fetch is in flight) ---
// Two columns of muted cells mimic the masonry layout shape so the transition
// into real items doesn't visually relayout the viewport. Cells pulse in
// opacity to signal "loading, not broken" — a static gray grid reads as a
// frozen state.

// SkeletonBlock lives at module scope so the function reference is stable
// across SkeletonGrid renders — defining it inside SkeletonGrid recreates
// the component identity each render, unmounting+remounting all 8 cells and
// resetting the pulse animation mid-stride.
function SkeletonBlock({ h, pulseStyle }: {
  h: number;
  pulseStyle: ReturnType<typeof useAnimatedStyle>;
}) {
  return (
    <Animated.View
      style={[
        pulseStyle,
        { height: h, backgroundColor: colors.bg.skeleton, borderRadius: 4, marginBottom: GAP },
      ]}
    />
  );
}

function SkeletonGrid({ topPad = 4 }: { topPad?: number }) {
  const opacity = useSharedValue(0.45);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 800 }),
        withTiming(0.45, { duration: 800 }),
      ),
      -1,
      false,
    );
  }, [opacity]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  const heights = [180, 240, 200, 160, 220, 180, 240, 200];
  const left = heights.filter((_, i) => i % 2 === 0);
  const right = heights.filter((_, i) => i % 2 === 1);
  return (
    <XStack paddingHorizontal={PAD} paddingTop={topPad + 4}>
      <YStack flex={1} marginRight={GAP / 2}>
        {left.map((h, i) => <SkeletonBlock key={`l-${i}`} h={h} pulseStyle={pulseStyle} />)}
      </YStack>
      <YStack flex={1} marginLeft={GAP / 2}>
        {right.map((h, i) => <SkeletonBlock key={`r-${i}`} h={h} pulseStyle={pulseStyle} />)}
      </YStack>
    </XStack>
  );
}

// --- Batch action bar (P2.4) ---

type BatchPanelMode = null | 'star' | 'tag';

function BatchActionBar({ count, onSetStar, onAddTag, onTrash }: {
  count: number;
  onSetStar: (star: number) => void;
  onAddTag: (tag: string) => void;
  onTrash: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [panel, setPanel] = useState<BatchPanelMode>(null);
  const [tagDraft, setTagDraft] = useState('');

  const submitTag = () => {
    const t = tagDraft.trim();
    if (!t) return;
    onAddTag(t);
    setTagDraft('');
    setPanel(null);
  };

  const confirmTrash = () => {
    Alert.alert(
      `删除 ${count} 张图片`, '将移入回收站',
      [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: onTrash },
      ],
    );
  };

  return (
    <YStack position="absolute" left={0} right={0} bottom={0}
      backgroundColor={colors.bg.surface} paddingTop={10}
      paddingBottom={(insets.bottom || 0) + 10}
      paddingHorizontal={16}
      borderTopWidth={1} borderTopColor={colors.border.subtle}>
      {/* Expandable panel above the action row */}
      {panel === 'star' && (
        <XStack justifyContent="center" gap={8} paddingBottom={10}>
          {[0, 1, 2, 3, 4, 5].map(n => (
            <Pressable key={n} hitSlop={6} onPress={() => { onSetStar(n); setPanel(null); }}>
              {n === 0 ? (
                <XStack backgroundColor={colors.bg.subtle} borderRadius={16}
                  paddingHorizontal={10} paddingVertical={4}>
                  <Text fontSize={12} color={colors.text.tertiary}>清除</Text>
                </XStack>
              ) : (
                <Star size={26} color={colors.status.warning} fill={colors.status.warning} />
              )}
            </Pressable>
          ))}
        </XStack>
      )}
      {panel === 'tag' && (
        <XStack alignItems="center" gap={8} paddingBottom={10}>
          <XStack flex={1} backgroundColor={colors.bg.subtle} borderRadius={8} paddingHorizontal={10}>
            <Input flex={1} value={tagDraft} onChangeText={setTagDraft}
              onSubmitEditing={submitTag} placeholder="输入标签后回车"
              backgroundColor="transparent" borderWidth={0}
              color={colors.text.primary} fontSize={14} height={36}
              autoFocus returnKeyType="done" />
          </XStack>
          <Pressable onPress={submitTag} hitSlop={4}>
            <Text fontSize={13} color={colors.brand.primary} fontWeight="600">添加</Text>
          </Pressable>
        </XStack>
      )}

      <XStack alignItems="center" justifyContent="space-between">
        <Text fontSize={13} color={colors.text.secondary}>已选 {count} 项</Text>
        <XStack gap={18} alignItems="center">
          <Pressable onPress={() => setPanel(panel === 'star' ? null : 'star')} hitSlop={6}>
            <Star size={22}
              color={panel === 'star' ? colors.brand.primary : colors.text.secondary} />
          </Pressable>
          <Pressable onPress={() => setPanel(panel === 'tag' ? null : 'tag')} hitSlop={6}>
            <Tag size={22}
              color={panel === 'tag' ? colors.brand.primary : colors.text.secondary} />
          </Pressable>
          <Pressable onPress={confirmTrash} hitSlop={6}>
            <Trash2 size={22} color={colors.status.error} />
          </Pressable>
        </XStack>
      </XStack>
    </YStack>
  );
}

// --- Import progress modal (Phase 3) ---

type ImportStateShape =
  | { stage: 'idle' }
  | { stage: 'uploading'; current: number; total: number; failed: number }
  | { stage: 'importing'; uploaded: number; total: number; progress: number; failed: number }
  | { stage: 'done'; processed: number; failed: number; total: number };

function ImportProgressModal({ state, onDismiss }: {
  state: ImportStateShape;
  onDismiss: () => void;
}) {
  if (state.stage === 'idle') return null;
  const dismissable = state.stage === 'done';

  let title = '';
  let body: React.ReactNode = null;

  if (state.stage === 'uploading') {
    title = '上传到中转';
    body = (
      <YStack alignItems="center" gap={10} paddingVertical={8}>
        <Spinner size="large" color={colors.brand.primary} />
        <Text fontSize={14} color={colors.text.secondary}>{state.current} / {state.total}</Text>
        {state.failed > 0 && (
          <Text fontSize={12} color={colors.status.error}>{state.failed} 张上传失败</Text>
        )}
      </YStack>
    );
  } else if (state.stage === 'importing') {
    title = '导入到素材库';
    body = (
      <YStack alignItems="center" gap={10} paddingVertical={8}>
        <Spinner size="large" color={colors.brand.primary} />
        <Text fontSize={14} color={colors.text.secondary}>{state.progress} / {state.uploaded}</Text>
        <Text fontSize={11} color={colors.text.tertiary}>桌面端正在写入</Text>
      </YStack>
    );
  } else {
    title = '完成';
    body = (
      <YStack alignItems="center" gap={8} paddingVertical={8}>
        <CircleCheck size={48}
          color={state.failed === 0 ? colors.status.success : colors.status.warning} />
        <Text fontSize={14} color={colors.text.secondary}>
          成功 {state.processed} 张{state.failed > 0 ? `,失败 ${state.failed} 张` : ''}
        </Text>
      </YStack>
    );
  }

  return (
    <Modal visible animationType="fade" transparent onRequestClose={dismissable ? onDismiss : undefined}>
      <Pressable
        style={{ flex: 1, backgroundColor: colors.overlay.scrimStrong,
                 justifyContent: 'center', alignItems: 'center' }}
        onPress={dismissable ? onDismiss : undefined}
      >
        <Pressable onPress={e => e.stopPropagation()}
          style={{ width: '78%', backgroundColor: colors.bg.surface, borderRadius: 14, padding: 22 }}>
          <Text fontSize={16} fontWeight="600" color={colors.text.primary} marginBottom={12}
            textAlign="center">{title}</Text>
          {body}
          {dismissable && (
            <Pressable onPress={onDismiss} hitSlop={6} style={{ marginTop: 16 }}>
              <Text fontSize={14} color={colors.brand.primary} fontWeight="600" textAlign="center">关闭</Text>
            </Pressable>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// --- Folder name dialog (P2.5: create + rename) ---

function FolderNameDialog({ state, onSubmit, onClose }: {
  state: { mode: 'create' } | { mode: 'rename'; folder: LibraryFolder } | null;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!state) { setValue(''); return; }
    setValue(state.mode === 'rename' ? state.folder.name : '');
  }, [state]);

  if (!state) return null;

  const title = state.mode === 'create' ? '新建文件夹' : '重命名文件夹';
  const submit = () => {
    const n = value.trim();
    if (!n) return;
    if (state.mode === 'rename' && n === state.folder.name) { onClose(); return; }
    onSubmit(n);
  };

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: colors.overlay.scrimStrong,
                           justifyContent: 'center', alignItems: 'center' }}
        onPress={onClose}>
        <Pressable onPress={e => e.stopPropagation()}
          style={{ width: '82%', backgroundColor: colors.bg.surface, borderRadius: 14, padding: 20 }}>
          <Text fontSize={16} fontWeight="600" color={colors.text.primary} marginBottom={12}>{title}</Text>
          <Input value={value} onChangeText={setValue}
            placeholder="文件夹名" autoFocus returnKeyType="done"
            onSubmitEditing={submit}
            backgroundColor={colors.bg.subtle} borderWidth={0} borderRadius={8}
            color={colors.text.primary} fontSize={15} height={40} paddingHorizontal={12} />
          <XStack justifyContent="flex-end" gap={16} marginTop={16}>
            <Pressable onPress={onClose} hitSlop={6}>
              <Text fontSize={14} color={colors.text.tertiary}>取消</Text>
            </Pressable>
            <Pressable onPress={submit} hitSlop={6}>
              <Text fontSize={14} color={colors.brand.primary} fontWeight="600">确定</Text>
            </Pressable>
          </XStack>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// --- Detail Modal ---
//
// Aligned with the main gallery surface: clean white sheet, system sans
// typography, lucide icons, token-based color. Replaces an earlier
// editorial / atelier look (serif italic, monospace section labels, warm
// paper background) — kept here only as a comment for design intent
// archaeology, in case we want to revisit a more distinct voice later.

function DetailModal({ item, items, getThumb, onClose, onOpenLightbox,
                      onIndexChange, onUpdateItem, onTrash, onPoseSearch }: {
  item: LibraryItem | null;
  items: LibraryItem[];
  getThumb: (id: string) => string | undefined;
  onClose: () => void;
  onOpenLightbox: (item: LibraryItem, thumbRef: AnimatedRef<any>) => void;
  // Fired when the user swipes the hero pager to a different page. Parent
  // updates `item` to keep the modal + lightbox in lock-step.
  onIndexChange: (i: number) => void;
  onUpdateItem?: (itemId: string, fields: Partial<LibraryItem>) => void;
  onTrash?: (itemId: string) => void;
  onPoseSearch?: (itemId: string) => void;
}) {
  // Ref to the big-image wrapper. Measured by Lightbox.openLightbox in the
  // UI thread to derive the hero animation start rect. Always rebinds to
  // whichever page is currently active in the pager.
  const thumbRef = useAnimatedRef<Animated.View>();
  const insets = useSafeAreaInsets();
  const pagerRef = useRef<PagerView | null>(null);

  // currentIndex is derived from item.id rather than tracked separately so
  // there's no two-source-of-truth race when `item` is updated from outside
  // (lightbox close, external selection, etc.).
  const currentIndex = item ? items.findIndex(i => i.id === item.id) : -1;
  // Pager's `initialPage` only takes effect on first mount; reuse the index
  // captured at mount time so re-renders don't re-trigger any odd jumps.
  const initialIndexRef = useRef(currentIndex >= 0 ? currentIndex : 0);
  // Tracks the pager's last-known native page. Used to detect external item
  // changes (currentIndex changed but pager didn't fire onPageSelected) and
  // call setPageWithoutAnimation. Pager-initiated changes update this ref in
  // onPageSelected BEFORE React re-renders so the effect below is a no-op.
  const pagerPageRef = useRef(initialIndexRef.current);

  // Sync external item changes to the pager. Self-initiated swipes are
  // already in sync by the time the effect runs, so they're a no-op.
  useEffect(() => {
    if (currentIndex < 0) return;
    if (pagerPageRef.current === currentIndex) return;
    pagerPageRef.current = currentIndex;
    pagerRef.current?.setPageWithoutAnimation(currentIndex);
  }, [currentIndex]);

  const [annotationDraft, setAnnotationDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  useEffect(() => {
    setAnnotationDraft(item?.annotation || '');
    setTagDraft('');
  }, [item?.id, item?.annotation]);

  const openLightbox = () => {
    if (!item) return;
    onOpenLightbox(item, thumbRef);
  };

  const setStar = (n: number) => {
    if (!item || !onUpdateItem) return;
    onUpdateItem(item.id, { star: n === (item.star || 0) ? 0 : n });
  };

  const removeTag = (tag: string) => {
    if (!item || !onUpdateItem) return;
    onUpdateItem(item.id, { tags: item.tags.filter(t => t !== tag) });
  };

  const addTag = () => {
    if (!item || !onUpdateItem) return;
    const t = tagDraft.trim();
    if (!t || item.tags.includes(t)) { setTagDraft(''); return; }
    onUpdateItem(item.id, { tags: [...item.tags, t] });
    setTagDraft('');
  };

  const commitAnnotation = () => {
    if (!item || !onUpdateItem) return;
    const next = annotationDraft.trim();
    if (next === (item.annotation || '').trim()) return;
    onUpdateItem(item.id, { annotation: next });
  };

  if (!item) return null;

  // Filename for display drops the extension — the ext appears separately in
  // the metadata caption below, so the title reads cleaner as a "work title".
  const displayName = item.name.replace(/\.[^.]+$/, '');
  const imgW = SCREEN_W - 40;            // 20px gutter each side
  // Image cap so meta + actions are visible without scroll on first open.
  // Pager has fixed height = cap; each page's image fits within via its
  // own aspect-correct box centered vertically inside the page.
  const imgHCap = Math.min(SCREEN_H * 0.42, 400);
  const star = item.star || 0;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      {/* RN touch-responder fix: outer is a plain View (not a Pressable) so
          gesture events inside the sheet propagate to the ScrollView. The
          backdrop is a sibling Pressable; sheet sits on top via render order. */}
      <View style={{ flex: 1 }}>
        <Pressable
          style={{ ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay.scrim }}
          onPress={onClose}
        />
        <View
          style={{
            position: 'absolute',
            bottom: 0, left: 0, right: 0,
            backgroundColor: colors.bg.canvas,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            maxHeight: '92%',
            overflow: 'hidden',
          }}
        >
          {/* Drag handle */}
          <YStack alignItems="center" paddingTop={10} paddingBottom={6}>
            <YStack width={36} height={4} borderRadius={2}
              backgroundColor={colors.border.default} />
          </YStack>

          {/* Hero pager — sits outside the ScrollView so it stays anchored
              at the top while metadata scrolls underneath. Each page renders
              one item's image; only the active page (and its ±1 neighbors)
              actually mount the Image to keep large libraries cheap. The
              active page wears thumbRef so the lightbox hero animation can
              still measure from the right view after a swipe. */}
          <PagerView
            ref={pagerRef}
            style={{ width: SCREEN_W, height: imgHCap, marginTop: 4 }}
            initialPage={initialIndexRef.current}
            onPageSelected={e => {
              const pos = e.nativeEvent.position;
              pagerPageRef.current = pos;
              onIndexChange(pos);
            }}
          >
            {items.map((it, i) => {
              const isActive = i === currentIndex;
              const inWindow = Math.abs(i - currentIndex) <= 1;
              const arIt = it.width && it.height ? it.width / it.height : 1;
              const hIt = Math.min(imgW / arIt, imgHCap);
              const thumbIt = getThumb(it.id);
              return (
                <View key={it.id} style={{ justifyContent: 'center', alignItems: 'center' }}>
                  {inWindow && (
                    <Pressable onPress={isActive ? openLightbox : undefined}>
                      <Animated.View
                        ref={isActive ? thumbRef : undefined}
                        collapsable={false}
                        style={{
                          width: imgW - 8, height: hIt,
                          backgroundColor: colors.bg.thumb,
                          borderRadius: 12,
                          overflow: 'hidden',
                        }}
                      >
                        {thumbIt ? (
                          <Image source={thumbIt}
                            style={{ width: imgW - 8, height: hIt }}
                            contentFit="contain"
                            cachePolicy="memory-disk"
                            placeholder={it.blurhash ? { blurhash: it.blurhash } : undefined}
                            placeholderContentFit="contain"
                            transition={150} />
                        ) : (
                          <YStack flex={1} justifyContent="center" alignItems="center">
                            <Spinner size="small" color={colors.brand.primary} />
                          </YStack>
                        )}
                      </Animated.View>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </PagerView>

          {/* Metadata — scrolls vertically below the hero pager. Each block
              has its own visual idiom matched to the data type (hero
              typography / inline meta strip / chip group / annotation accent
              / icon-led link). Different idioms create hierarchy that 4
              same-shaped Field rows can't. */}
          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 16, paddingBottom: 24 }}
            keyboardShouldPersistTaps="handled"
          >
            {/* Hero typography — filename dominates, meta + rating ride
                along on a single small caption row to free vertical space. */}
            <YStack gap={8}>
              <Text
                color={colors.text.primary}
                fontSize={24}
                fontWeight="600"
                lineHeight={30}
                numberOfLines={3}
              >
                {displayName}
              </Text>
              <XStack alignItems="center" gap={10} flexWrap="wrap">
                <Text color={colors.text.tertiary} fontSize={12}>
                  {(item.ext || '').toUpperCase()} · {item.width} × {item.height} · {fmtSize(item.size)}
                </Text>
                {star > 0 && (
                  <XStack alignItems="center" gap={3}>
                    <Star size={12} color={colors.brand.primary} fill={colors.brand.primary} />
                    <Text color={colors.brand.primary} fontSize={12} fontWeight="600">{star}</Text>
                  </XStack>
                )}
              </XStack>
            </YStack>

            {/* Rating row — interactive stars without a label. The stars
                themselves communicate "rating", and putting them right after
                the meta caption ties them to the file identity. */}
            {onUpdateItem && (
              <XStack alignItems="center" gap={8} marginTop={22}>
                {[1, 2, 3, 4, 5].map(i => {
                  const filled = i <= star;
                  return (
                    <Pressable key={i} hitSlop={6} onPress={() => setStar(i)}>
                      <Star size={24}
                        color={filled ? colors.brand.primary : colors.text.faint}
                        fill={filled ? colors.brand.primary : 'none'} />
                    </Pressable>
                  );
                })}
              </XStack>
            )}

            {/* Tags — chips row, add input on its own row so the input has
                room to breathe (cramming a tiny input at the end of a wrap
                row read as "shrunk and afterthought"). */}
            <YStack marginTop={onUpdateItem ? 20 : 24} gap={10}>
              {item.tags.length > 0 ? (
                <XStack flexWrap="wrap" gap={6} rowGap={8} alignItems="center">
                  {item.tags.map(t => (
                    <Pressable key={t}
                      onPress={onUpdateItem ? () => removeTag(t) : undefined}
                      hitSlop={4}
                    >
                      <XStack backgroundColor={colors.brand.soft}
                        borderRadius={12} paddingHorizontal={10} paddingVertical={4}
                        alignItems="center" gap={5}>
                        <Text fontSize={13} color={colors.brand.primary}>{t}</Text>
                        {onUpdateItem && <X size={12} color={colors.brand.primary} />}
                      </XStack>
                    </Pressable>
                  ))}
                </XStack>
              ) : !onUpdateItem ? (
                <Text color={colors.text.muted} fontSize={13}>暂无标签</Text>
              ) : null}
              {onUpdateItem && (
                <XStack
                  backgroundColor={colors.bg.subtle}
                  borderRadius={12}
                  paddingHorizontal={12}
                  alignItems="center"
                  gap={8}
                  height={36}
                >
                  <Plus size={14} color={colors.text.tertiary} />
                  <Input
                    flex={1}
                    value={tagDraft}
                    onChangeText={setTagDraft}
                    onSubmitEditing={addTag}
                    placeholder="添加标签后回车"
                    placeholderTextColor={colors.text.muted as any}
                    backgroundColor="transparent" borderWidth={0}
                    color={colors.text.primary} fontSize={13}
                    height={36}
                    paddingHorizontal={0}
                    returnKeyType="done"
                  />
                </XStack>
              )}
            </YStack>

            {/* Notes — annotation accent (margin-note idiom). */}
            <XStack alignItems="stretch" minHeight={48} marginTop={24}>
              <YStack
                width={2}
                backgroundColor={colors.brand.primary}
                opacity={0.35}
                borderRadius={1}
                marginRight={14}
              />
              {onUpdateItem ? (
                <Input
                  flex={1}
                  value={annotationDraft}
                  onChangeText={setAnnotationDraft}
                  onBlur={commitAnnotation}
                  placeholder="写点什么…"
                  placeholderTextColor={colors.text.muted as any}
                  multiline
                  backgroundColor="transparent"
                  borderWidth={0}
                  color={colors.text.primary}
                  fontSize={14}
                  lineHeight={22}
                  paddingHorizontal={0}
                  paddingVertical={2}
                  textAlignVertical="top"
                />
              ) : item.annotation ? (
                <Text flex={1} color={colors.text.primary} fontSize={14} lineHeight={22}>
                  {item.annotation}
                </Text>
              ) : (
                <Text flex={1} color={colors.text.muted} fontSize={14} lineHeight={22}>
                  尚未添加备注
                </Text>
              )}
            </XStack>

            {/* Source URL — icon-led inline, no label. The link icon both
                identifies the row's purpose and gives the URL a left anchor
                so long strings wrap cleanly. */}
            {item.url ? (
              <XStack alignItems="flex-start" gap={10} marginTop={22}>
                <Link2 size={14} color={colors.text.tertiary} style={{ marginTop: 4 }} />
                <Text
                  flex={1}
                  color={colors.brand.primary}
                  fontSize={13}
                  lineHeight={20}
                  numberOfLines={2}
                >
                  {item.url}
                </Text>
              </XStack>
            ) : null}
          </ScrollView>

          {/* Fixed footer — always reachable regardless of scroll position.
              Sits on top of the safe-area bottom so destructive actions
              don't disappear behind gesture bars. */}
          <XStack
            paddingHorizontal={20}
            paddingTop={12}
            paddingBottom={insets.bottom + 12}
            backgroundColor={colors.bg.canvas}
            borderTopWidth={1}
            borderTopColor={colors.border.hairline}
            justifyContent="space-between"
            alignItems="center"
          >
            <XStack gap={20} alignItems="center">
              {onPoseSearch && (
                <Pressable onPress={() => onPoseSearch(item.id)} hitSlop={8}>
                  <XStack alignItems="center" gap={6}>
                    <Crosshair size={18} color={colors.text.secondary} />
                    <Text fontSize={14} color={colors.text.secondary}>姿势搜索</Text>
                  </XStack>
                </Pressable>
              )}
              {onTrash && (
                <Pressable hitSlop={8}
                  onPress={() => Alert.alert('删除该图片', '将移入回收站', [
                    { text: '取消', style: 'cancel' },
                    { text: '删除', style: 'destructive', onPress: () => onTrash(item.id) },
                  ])}
                >
                  <XStack alignItems="center" gap={6}>
                    <Trash2 size={18} color={colors.status.danger} />
                    <Text fontSize={14} color={colors.status.danger}>删除</Text>
                  </XStack>
                </Pressable>
              )}
            </XStack>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text fontSize={14} color={colors.text.secondary}>关闭</Text>
            </Pressable>
          </XStack>
        </View>
      </View>
    </Modal>
  );
}

