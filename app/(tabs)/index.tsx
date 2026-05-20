import {
  Pressable, Dimensions, Modal, ScrollView, FlatList,
  BackHandler, Platform, StyleSheet, Alert, View,
} from 'react-native';
import { Image } from 'expo-image';
import { FlashList } from '@shopify/flash-list';
import { YStack, XStack, Text, Spinner, Button, Input } from 'tamagui';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Unplug, Search, CircleX, ImagePlus, X, FolderPlus,
  Images, Check, Folder, SquareCheck, Square,
  Image as ImageIcon, Star, Tag, Trash2, CircleCheck,
  MoreVertical, SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react-native';
import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { useFocusEffect } from 'expo-router';
import Animated, {
  type AnimatedRef, useAnimatedRef,
  useSharedValue, useAnimatedStyle,
  withRepeat, withSequence, withTiming,
} from 'react-native-reanimated';
import { remoteWS, RemoteMessage, RemoteWebSocket } from '../../utils/websocket';
import { isLoggedIn } from '../../utils/auth';
import { useLightbox, useLightboxControls, type ImageSource as LbImageSource } from '../../components/Lightbox';
import * as ImagePicker from 'expo-image-picker';

// --- Types ---

type LibraryFolder = {
  id: string; name: string;
  count?: number;
  imageCount?: number;
  folderCount?: number;
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
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [error, setError] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbRequested = useRef<Set<string>>(new Set());
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

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState('');
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
    const unsubState = remoteWS.onStateChange(updateConnected);
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

  // Phone gallery → library import (Phase 3). Sequential R2 upload (concurrency
  // 1 keeps the radio happy and lets us report a meaningful per-item progress).
  // Imports into the currently active folder if one is selected.
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

      const assets = picked.assets;
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
    } catch (e) {
      console.warn('[import] aborted', e);
      setImportState({ stage: 'idle' });
      Alert.alert('导入失败', String(e));
    }
  }, [importState.stage, activeFolder]);

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
      openLightboxControl({ images: lbImages, index: idx });
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
    } catch {
      // all probes failed — leave fileServerUrl null so WS path kicks in
    }
  }, []);

  // Message listener
  useEffect(() => {
    const unsub = remoteWS.onMessage((msg: RemoteMessage) => {
      if (!msg.data) return;
      if (msg.type === 'status') {
        const d = msg.data as { fileServerUrls?: string[] };
        if (d.fileServerUrls?.length) probeFileServers(d.fileServerUrls);
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
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: { item: LibraryItem }[] }) => {
      if (fileServerUrl) return; // LAN serves thumbs directly by URL, no request needed
      for (const v of viewableItems) {
        const id = v.item?.id;
        if (!id || thumbRequested.current.has(id)) continue;
        thumbRequested.current.add(id);
        remoteWS.requestThumbnail(id);
      }
    },
    [fileServerUrl]
  );
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  // Auto-connect to relay when this tab is focused. Lifted here from the
  // (deleted) workshop tab — without it, remoteWS.connect() is never called
  // and the gallery sits forever on "桌面端未连接".
  useFocusEffect(useCallback(() => {
    (async () => {
      if (await isLoggedIn()) remoteWS.connect();
    })();
  }, []));

  // Initial load
  useFocusEffect(useCallback(() => {
    if (!connected) return;
    if (!fileServerUrl) remoteWS.requestStatus();
    if (items.length === 0 && !loading) doSearch({});
    if (folders.length === 0) remoteWS.requestFolders();
    if (allTags.length === 0) remoteWS.requestTags();
  }, [connected]));

  // Execute search with given params (replaces fetchImages)
  const doSearch = useCallback((params: {
    keyword?: string; tags?: string[]; rating?: number; folderId?: string;
  }) => {
    setLoading(true); setError('');
    setItems([]); setTotalItems(0);
    setThumbs({}); thumbRequested.current.clear();
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

  const renderCell = useCallback(({ item }: { item: LibraryItem }) => {
    const thumbUrl = fileServerUrl
      ? `${fileServerUrl}/thumb/${item.id}`
      : thumbsRef.current[item.id];
    return (
      <MemoCell
        item={item}
        thumb={thumbUrl}
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
  }, [fileServerUrl, selectMode, selectedIds, toggleSelected, enterSelectMode, thumbsVersion]);

  if (!connected) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#fafafa' }}>
        <YStack padding="$4"><Text fontSize={28} fontWeight="700" color="#1d1d1f">素材库</Text></YStack>
        <YStack flex={1} justifyContent="center" alignItems="center" gap="$3">
          <YStack width={80} height={80} borderRadius={40} backgroundColor="#f0f0f0"
            justifyContent="center" alignItems="center">
            <Unplug size={36} color="#ccc" />
          </YStack>
          <Text color="#999" fontSize={16}>桌面端未连接</Text>
          <Text color="#bbb" fontSize={13} textAlign="center" lineHeight={20}>
            {'请在电脑上打开 Nephele'}
          </Text>
        </YStack>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fafafa' }}>
      {/* Search bar — pull-to-refresh replaces the old refresh icon button;
          select mode toggle moved to kebab (one-tap for now; will expand to
          action sheet once we add a second menu entry). */}
      <XStack paddingHorizontal={16} paddingTop={10} paddingBottom={8} gap={14} alignItems="center">
        <XStack flex={1} backgroundColor="#fff" borderRadius={12} paddingLeft={12}
          alignItems="center" borderWidth={1} borderColor={searchQuery ? '#b388ff' : '#ececec'}
          height={40}>
          <Search size={18} color="#999" />
          <Input flex={1} placeholder="搜索素材..." value={searchQuery}
            onChangeText={onSearchChange} backgroundColor="transparent" borderWidth={0}
            color="#1d1d1f" fontSize={14} height={38}
            placeholderTextColor="#bbb" returnKeyType="search" />
          {searchQuery ? (
            <Pressable onPress={() => onSearchChange('')} style={{ paddingRight: 10 }} hitSlop={6}>
              <CircleX size={16} color="#ccc" />
            </Pressable>
          ) : null}
        </XStack>
        <Pressable onPress={importFromGallery} hitSlop={8}
          disabled={importState.stage === 'uploading' || importState.stage === 'importing'}>
          <ImagePlus size={22}
            color={importState.stage === 'uploading' || importState.stage === 'importing'
              ? '#ccc' : '#666'} />
        </Pressable>
        <Pressable onPress={selectMode ? exitSelectMode : () => enterSelectMode()} hitSlop={8}>
          {selectMode
            ? <X size={22} color="#666" />
            : <MoreVertical size={22} color="#666" />}
        </Pressable>
      </XStack>

      {/* Filter row — folder chip + combined filter chip (tag + rating live
          in TagPickerSheet now); count moved inline to the right edge. */}
      <XStack paddingHorizontal={16} paddingBottom={10} alignItems="center" gap={8}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 1, flexShrink: 1 }}
          contentContainerStyle={{ gap: 8, alignItems: 'center' }}>
          <Pressable onPress={() => setFilterOpen(true)}>
            <FilterChip label={activeFolder ? activeFolder.name : '文件夹'}
              active={!!activeFolder} icon={Folder} />
          </Pressable>
          <Pressable onPress={() => setTagPickerOpen(true)}>
            <FilterChip label={filterSummary}
              active={filterSummaryActive} icon={SlidersHorizontal} />
          </Pressable>
          {hasAnyFilter && (
            <Pressable onPress={clearAllFilters} hitSlop={4}>
              <XStack alignItems="center" gap={4} paddingHorizontal={6} paddingVertical={5}>
                <X size={14} color="#999" />
                <Text fontSize={12} color="#999">清除</Text>
              </XStack>
            </Pressable>
          )}
        </ScrollView>
        {totalItems > 0 && (
          <Text fontSize={12} color="#999">{totalItems}</Text>
        )}
      </XStack>

      {error ? (
        <YStack marginHorizontal="$4" marginBottom="$2" backgroundColor="#fff3f3"
          borderRadius="$3" padding="$2.5">
          <Text color="#cc4444" fontSize={13}>{error}</Text>
        </YStack>
      ) : null}

      {loading ? (
        <SkeletonGrid />
      ) : (
        <FlashList
          data={items}
          numColumns={2}
          masonry
          optimizeItemArrangement
          renderItem={renderCell}
          // Without keyExtractor, FlashList falls back to index as the React
          // key. Index keys break when items grows (loadMore append), causing
          // cells to misidentify which item they're rendering after recycle.
          keyExtractor={(item: LibraryItem) => item.id}
          contentContainerStyle={{ paddingHorizontal: PAD, paddingBottom: 20 }}
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
            <YStack paddingTop="$10" alignItems="center">
              <Text color="#999" fontSize={14}>
                {activeFolder ? '该文件夹没有图片' : '素材库中没有图片'}
              </Text>
            </YStack>
          }
          ListFooterComponent={
            loadingMore ? (
              <YStack padding="$3" alignItems="center"><Spinner size="small" color="#b388ff" /></YStack>
            ) : items.length > 0 && items.length >= totalItems ? (
              <YStack padding="$3" alignItems="center"><Text color="#ccc" fontSize={12}>已加载全部</Text></YStack>
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

      {/* Detail Modal */}
      <DetailModal item={detailItem}
        thumb={detailItem
          ? (fileServerUrl
              ? `${fileServerUrl}/thumb/${detailItem.id}`
              : thumbs[detailItem.id])
          : undefined}
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

      {/* Import progress modal */}
      <ImportProgressModal
        state={importState}
        onDismiss={() => setImportState({ stage: 'idle' })}
      />
    </SafeAreaView>
  );
}

// --- Folder filter bottom sheet ---

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
  if (!visible) return null;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }} onPress={onClose}>
        <Pressable
          style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            backgroundColor: '#fff',
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            maxHeight: '70%',
            paddingBottom: insets.bottom || 16,
          }}
          onPress={e => e.stopPropagation()}
        >
          <YStack alignItems="center" paddingVertical={10}>
            <YStack width={36} height={4} borderRadius={2} backgroundColor="#ddd" />
          </YStack>
          <XStack paddingHorizontal={16} marginBottom={8} alignItems="center" justifyContent="space-between">
            <Text fontSize={17} fontWeight="600" color="#1d1d1f">按文件夹筛选</Text>
            {onCreate && (
              <Pressable onPress={onCreate} hitSlop={6}>
                <XStack alignItems="center" gap={4}>
                  <FolderPlus size={18} color="#b388ff" />
                  <Text fontSize={13} color="#b388ff" fontWeight="600">新建</Text>
                </XStack>
              </Pressable>
            )}
          </XStack>

          <FlatList
            style={{ maxHeight: SCREEN_H * 0.55 }}
            data={folders}
            keyExtractor={f => f.id}
            initialNumToRender={15}
            maxToRenderPerBatch={10}
            getItemLayout={(_, i) => ({ length: 44, offset: 44 * i, index: i })}
            ListHeaderComponent={
              <Pressable onPress={() => onSelect(null)}>
                <XStack paddingHorizontal={16} paddingVertical={12} alignItems="center" gap={12}
                  backgroundColor={activeId === null ? '#f8f0ff' : 'transparent'}>
                  <Images size={20}
                    color={activeId === null ? '#b388ff' : '#999'} />
                  <Text flex={1} fontSize={15} color={activeId === null ? '#b388ff' : '#1d1d1f'}
                    fontWeight={activeId === null ? '600' : '400'}>全部图片</Text>
                  {activeId === null && <Check size={18} color="#b388ff" />}
                </XStack>
              </Pressable>
            }
            renderItem={({ item: f }) => {
              const isActive = f.id === activeId;
              const imgCount = f.imageCount ?? f.count ?? 0;
              return (
                <Pressable onPress={() => onSelect(f)}
                  onLongPress={onRequestRename ? () => onRequestRename(f) : undefined}
                  delayLongPress={400}>
                  <XStack paddingHorizontal={16} paddingVertical={12} alignItems="center" gap={12}
                    backgroundColor={isActive ? '#f8f0ff' : 'transparent'}>
                    <Folder size={20}
                      color={isActive ? '#b388ff' : '#999'} />
                    <Text flex={1} fontSize={15} color={isActive ? '#b388ff' : '#1d1d1f'}
                      fontWeight={isActive ? '600' : '400'} numberOfLines={1}>{f.name}</Text>
                    <Text fontSize={12} color="#bbb">{imgCount > 0 ? imgCount : ''}</Text>
                    {isActive && <Check size={18} color="#b388ff" />}
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
    <XStack backgroundColor={active ? '#f0e6ff' : '#fff'}
      borderRadius={16} paddingHorizontal={10} paddingVertical={5}
      alignItems="center" gap={4}
      borderWidth={1} borderColor={active ? '#b388ff' : '#e8e8e8'}>
      <Icon size={14} color={active ? '#b388ff' : '#999'} />
      <Text fontSize={12} color={active ? '#b388ff' : '#666'} numberOfLines={1} maxWidth={120}>
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
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }} onPress={onClose}>
        <Pressable
          style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            backgroundColor: '#fff',
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            maxHeight: '78%',
            paddingBottom: insets.bottom || 16,
          }}
          onPress={e => e.stopPropagation()}
        >
          <YStack alignItems="center" paddingVertical={10}>
            <YStack width={36} height={4} borderRadius={2} backgroundColor="#ddd" />
          </YStack>
          <Text fontSize={17} fontWeight="600" color="#1d1d1f" paddingHorizontal={16} marginBottom={12}>
            筛选
          </Text>

          {/* Rating row */}
          <XStack paddingHorizontal={16} marginBottom={14} alignItems="center" gap={8}>
            <Text fontSize={13} color="#999" width={32}>评分</Text>
            {[3, 4, 5].map(r => (
              <Pressable key={r} onPress={() => onSetRating(r)} hitSlop={4}>
                <XStack backgroundColor={rating === r ? '#f0e6ff' : '#fff'}
                  borderRadius={14} paddingHorizontal={10} paddingVertical={5}
                  alignItems="center" gap={4}
                  borderWidth={1} borderColor={rating === r ? '#b388ff' : '#ececec'}>
                  <Star size={12}
                    color={rating === r ? '#b388ff' : '#999'}
                    fill={rating === r ? '#b388ff' : 'none'} />
                  <Text fontSize={12} color={rating === r ? '#b388ff' : '#666'}>{r}+</Text>
                </XStack>
              </Pressable>
            ))}
          </XStack>

          <YStack height={1} backgroundColor="#f2f2f2" marginHorizontal={16} marginBottom={12} />

          <Text fontSize={13} color="#999" paddingHorizontal={16} marginBottom={8}>标签</Text>

          {/* Active tags */}
          {activeTags.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 16, gap: 6, paddingBottom: 8 }}>
              {activeTags.map(t => (
                <Pressable key={t} onPress={() => onToggle(t)}>
                  <XStack backgroundColor="#f0e6ff" borderRadius={12} paddingHorizontal={10}
                    paddingVertical={4} alignItems="center" gap={4}>
                    <Text fontSize={12} color="#b388ff">{t}</Text>
                    <X size={12} color="#b388ff" />
                  </XStack>
                </Pressable>
              ))}
            </ScrollView>
          )}

          {/* Search */}
          <XStack paddingHorizontal={16} marginBottom={8}>
            <Input flex={1} placeholder="搜索标签..." value={query} onChangeText={setQuery}
              backgroundColor="#f5f5f7" borderWidth={0} borderRadius={8}
              color="#1d1d1f" fontSize={14} height={36} placeholderTextColor="#bbb" />
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
                    backgroundColor={isActive ? '#f8f0ff' : 'transparent'}>
                    {isActive
                      ? <SquareCheck size={20} color="#b388ff" />
                      : <Square size={20} color="#ccc" />}
                    <Text flex={1} fontSize={15} color={isActive ? '#b388ff' : '#1d1d1f'}
                      numberOfLines={1}>{t.name}</Text>
                    <Text fontSize={12} color="#bbb">{t.count}</Text>
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

function CellInner({ item, thumb, selectMode, selected, onPress, onLongPress }: {
  item: LibraryItem; thumb?: string;
  selectMode: boolean; selected: boolean;
  onPress: () => void; onLongPress: () => void;
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
      <YStack borderRadius={4} overflow="hidden"
        borderWidth={selected ? 2 : 0} borderColor={selected ? '#b388ff' : 'transparent'}>
        <YStack height={h} backgroundColor="#f0f0f0" justifyContent="center" alignItems="center">
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
              />
            : <ImageIcon size={24} color="#ddd" />}
          {/* Selection checkbox overlay — only visible in select mode */}
          {selectMode && (
            <YStack position="absolute" top={6} right={6}
              width={22} height={22} borderRadius={11}
              backgroundColor={selected ? '#b388ff' : 'rgba(255,255,255,0.85)'}
              borderWidth={1} borderColor={selected ? '#b388ff' : '#ccc'}
              justifyContent="center" alignItems="center">
              {selected && <Check size={14} color="#fff" />}
            </YStack>
          )}
        </YStack>
      </YStack>
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
        { height: h, backgroundColor: '#eaeaea', borderRadius: 4, marginBottom: GAP },
      ]}
    />
  );
}

function SkeletonGrid() {
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
    <XStack paddingHorizontal={PAD} paddingTop={4}>
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
      backgroundColor="#fff" paddingTop={10}
      paddingBottom={(insets.bottom || 0) + 10}
      paddingHorizontal={16}
      borderTopWidth={1} borderTopColor="#eee">
      {/* Expandable panel above the action row */}
      {panel === 'star' && (
        <XStack justifyContent="center" gap={8} paddingBottom={10}>
          {[0, 1, 2, 3, 4, 5].map(n => (
            <Pressable key={n} hitSlop={6} onPress={() => { onSetStar(n); setPanel(null); }}>
              {n === 0 ? (
                <XStack backgroundColor="#f5f5f7" borderRadius={16}
                  paddingHorizontal={10} paddingVertical={4}>
                  <Text fontSize={12} color="#999">清除</Text>
                </XStack>
              ) : (
                <Star size={26} color="#f7b500" fill="#f7b500" />
              )}
            </Pressable>
          ))}
        </XStack>
      )}
      {panel === 'tag' && (
        <XStack alignItems="center" gap={8} paddingBottom={10}>
          <XStack flex={1} backgroundColor="#f5f5f7" borderRadius={8} paddingHorizontal={10}>
            <Input flex={1} value={tagDraft} onChangeText={setTagDraft}
              onSubmitEditing={submitTag} placeholder="输入标签后回车"
              backgroundColor="transparent" borderWidth={0}
              color="#1d1d1f" fontSize={14} height={36}
              autoFocus returnKeyType="done" />
          </XStack>
          <Pressable onPress={submitTag} hitSlop={4}>
            <Text fontSize={13} color="#b388ff" fontWeight="600">添加</Text>
          </Pressable>
        </XStack>
      )}

      <XStack alignItems="center" justifyContent="space-between">
        <Text fontSize={13} color="#666">已选 {count} 项</Text>
        <XStack gap={18} alignItems="center">
          <Pressable onPress={() => setPanel(panel === 'star' ? null : 'star')} hitSlop={6}>
            <Star size={22}
              color={panel === 'star' ? '#b388ff' : '#666'} />
          </Pressable>
          <Pressable onPress={() => setPanel(panel === 'tag' ? null : 'tag')} hitSlop={6}>
            <Tag size={22}
              color={panel === 'tag' ? '#b388ff' : '#666'} />
          </Pressable>
          <Pressable onPress={confirmTrash} hitSlop={6}>
            <Trash2 size={22} color="#cc4444" />
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
        <Spinner size="large" color="#b388ff" />
        <Text fontSize={14} color="#444">{state.current} / {state.total}</Text>
        {state.failed > 0 && (
          <Text fontSize={12} color="#cc4444">{state.failed} 张上传失败</Text>
        )}
      </YStack>
    );
  } else if (state.stage === 'importing') {
    title = '导入到素材库';
    body = (
      <YStack alignItems="center" gap={10} paddingVertical={8}>
        <Spinner size="large" color="#b388ff" />
        <Text fontSize={14} color="#444">{state.progress} / {state.uploaded}</Text>
        <Text fontSize={11} color="#888">桌面端正在写入</Text>
      </YStack>
    );
  } else {
    title = '完成';
    body = (
      <YStack alignItems="center" gap={8} paddingVertical={8}>
        <CircleCheck size={48}
          color={state.failed === 0 ? '#5cb85c' : '#f7b500'} />
        <Text fontSize={14} color="#444">
          成功 {state.processed} 张{state.failed > 0 ? `,失败 ${state.failed} 张` : ''}
        </Text>
      </YStack>
    );
  }

  return (
    <Modal visible animationType="fade" transparent onRequestClose={dismissable ? onDismiss : undefined}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
                 justifyContent: 'center', alignItems: 'center' }}
        onPress={dismissable ? onDismiss : undefined}
      >
        <Pressable onPress={e => e.stopPropagation()}
          style={{ width: '78%', backgroundColor: '#fff', borderRadius: 14, padding: 22 }}>
          <Text fontSize={16} fontWeight="600" color="#1d1d1f" marginBottom={12}
            textAlign="center">{title}</Text>
          {body}
          {dismissable && (
            <Pressable onPress={onDismiss} hitSlop={6} style={{ marginTop: 16 }}>
              <Text fontSize={14} color="#b388ff" fontWeight="600" textAlign="center">关闭</Text>
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
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
                           justifyContent: 'center', alignItems: 'center' }}
        onPress={onClose}>
        <Pressable onPress={e => e.stopPropagation()}
          style={{ width: '82%', backgroundColor: '#fff', borderRadius: 14, padding: 20 }}>
          <Text fontSize={16} fontWeight="600" color="#1d1d1f" marginBottom={12}>{title}</Text>
          <Input value={value} onChangeText={setValue}
            placeholder="文件夹名" autoFocus returnKeyType="done"
            onSubmitEditing={submit}
            backgroundColor="#f5f5f7" borderWidth={0} borderRadius={8}
            color="#1d1d1f" fontSize={15} height={40} paddingHorizontal={12} />
          <XStack justifyContent="flex-end" gap={16} marginTop={16}>
            <Pressable onPress={onClose} hitSlop={6}>
              <Text fontSize={14} color="#999">取消</Text>
            </Pressable>
            <Pressable onPress={submit} hitSlop={6}>
              <Text fontSize={14} color="#b388ff" fontWeight="600">确定</Text>
            </Pressable>
          </XStack>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// --- Detail Modal ---
//
// Editorial-atelier redesign: an artist's archive sheet rather than a generic
// photo-info modal. The body presents the image as a print with its title in
// large serif italic and its technical metadata as tracked uppercase monospace,
// like a contact sheet caption. Tags shed their chip fills for plain text with
// a single lavender underline; the rating is small and lavender-filled rather
// than gold-star material; actions are italic text affordances instead of
// solid pill buttons. Lavender (#b388ff, Nephele brand) is used sparingly so
// it actually reads as an accent.

function DetailModal({ item, thumb, onClose, onOpenLightbox, onUpdateItem, onTrash,
                      onPoseSearch }: {
  item: LibraryItem | null; thumb?: string;
  onClose: () => void;
  onOpenLightbox: (item: LibraryItem, thumbRef: AnimatedRef<any>) => void;
  onUpdateItem?: (itemId: string, fields: Partial<LibraryItem>) => void;
  onTrash?: (itemId: string) => void;
  onPoseSearch?: (itemId: string) => void;
}) {
  // Ref to the big-image wrapper. Measured by Lightbox.openLightbox in the
  // UI thread to derive the hero animation start rect.
  const thumbRef = useAnimatedRef<Animated.View>();
  const insets = useSafeAreaInsets();

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
  const ar = item.width && item.height ? item.width / item.height : 1;
  const imgW = SCREEN_W - 48;            // 24px gutter each side
  const imgH = Math.min(imgW / ar, 480);

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={DS.scrim} onPress={onClose}>
        <Pressable
          style={[DS.sheet, { paddingBottom: insets.bottom + 16 }]}
          onPress={e => e.stopPropagation()}
        >
          {/* Drag handle — slim, paper-cream */}
          <YStack alignItems="center" paddingTop={12} paddingBottom={4}>
            <YStack style={DS.handle} />
          </YStack>

          <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 12, paddingBottom: 8 }}>
            {/* Image — sits in a quiet warm-gray frame */}
            <Pressable onPress={openLightbox}>
              <Animated.View
                ref={thumbRef}
                collapsable={false}
                style={[DS.imageFrame, { width: imgW, height: imgH }]}
              >
                {thumb
                  ? <Image source={thumb} style={{ width: imgW, height: imgH }} contentFit="contain"
                      cachePolicy="memory-disk"
                      placeholder={item.blurhash ? { blurhash: item.blurhash } : undefined}
                      placeholderContentFit="contain"
                      transition={150} />
                  : <YStack flex={1} justifyContent="center" alignItems="center">
                      <Spinner size="small" color="#b388ff" />
                    </YStack>}
              </Animated.View>
            </Pressable>

            {/* Italic "view original" — small caption sitting just under the print */}
            <XStack justifyContent="center" marginTop={10} marginBottom={24}>
              <Pressable onPress={openLightbox} hitSlop={8}>
                <Text style={DS.expandHint}>view original ─ swipe to navigate</Text>
              </Pressable>
            </XStack>

            {/* Title — large serif italic */}
            <Text style={DS.title} numberOfLines={3}>{displayName}</Text>

            {/* Metadata — tracked uppercase mono, like a print's archival stamp */}
            <Text style={DS.meta}>
              {(item.ext || '').toUpperCase()}   ·   {item.width} × {item.height}   ·   {fmtSize(item.size)}
            </Text>

            <YStack style={DS.hairline} marginTop={20} marginBottom={24} />

            {/* Rating */}
            <Text style={DS.sectionLabel}>RATING</Text>
            <XStack alignItems="center" gap={6} marginBottom={28}>
              {[1, 2, 3, 4, 5].map(i => {
                const filled = i <= (item.star || 0);
                return (
                  <Pressable key={i} hitSlop={8}
                    onPress={onUpdateItem ? () => setStar(i) : undefined}>
                    <Star
                      size={18}
                      color={filled ? '#b388ff' : '#d2cdc1'}
                      fill={filled ? '#b388ff' : 'none'} />
                  </Pressable>
                );
              })}
              {(item.star || 0) === 0 && (
                <Text style={[DS.placeholder, { marginLeft: 8 }]}>—</Text>
              )}
            </XStack>

            {/* Tags */}
            <Text style={DS.sectionLabel}>TAGS</Text>
            <XStack flexWrap="wrap" gap={14} rowGap={12} marginBottom={28} alignItems="center">
              {item.tags.map(t => (
                <Pressable key={t}
                  onPress={onUpdateItem ? () => removeTag(t) : undefined}
                  hitSlop={4}
                >
                  <Text style={DS.tag}>{t}</Text>
                </Pressable>
              ))}
              {onUpdateItem && (
                <XStack alignItems="center" gap={4}>
                  <Text style={DS.tagAdd}>+</Text>
                  <Input
                    value={tagDraft}
                    onChangeText={setTagDraft}
                    onSubmitEditing={addTag}
                    placeholder="add"
                    placeholderTextColor={'#bcb6aa' as any}
                    backgroundColor="transparent" borderWidth={0}
                    color="#1c1a17" fontSize={14}
                    height={22} minWidth={56} paddingHorizontal={0} paddingVertical={0}
                    returnKeyType="done" />
                </XStack>
              )}
              {item.tags.length === 0 && !onUpdateItem && (
                <Text style={DS.placeholder}>—</Text>
              )}
            </XStack>

            {/* Notes / annotation */}
            <Text style={DS.sectionLabel}>NOTES</Text>
            <YStack marginBottom={28}>
              {onUpdateItem ? (
                <Input
                  value={annotationDraft}
                  onChangeText={setAnnotationDraft}
                  onBlur={commitAnnotation}
                  placeholder="—"
                  placeholderTextColor={'#bcb6aa' as any}
                  multiline
                  backgroundColor="transparent" borderWidth={0}
                  color="#3a342c" fontSize={14}
                  minHeight={28}
                  paddingHorizontal={0} paddingVertical={2}
                />
              ) : (
                item.annotation
                  ? <Text style={DS.body}>{item.annotation}</Text>
                  : <Text style={DS.placeholder}>—</Text>
              )}
            </YStack>

            {/* Source URL — when known, rendered as a quiet violet mono trace */}
            {item.url ? (
              <>
                <Text style={DS.sectionLabel}>SOURCE</Text>
                <Text style={DS.url} numberOfLines={2}>{item.url}</Text>
                <YStack height={28} />
              </>
            ) : null}

            <YStack style={DS.hairline} />

            {/* Action row — italic text affordances; left = ops on this work,
                right = dismiss. Delete shows an Alert before destructive call. */}
            <XStack justifyContent="space-between" alignItems="center"
              paddingTop={20} paddingBottom={6}
            >
              <XStack gap={24} alignItems="center">
                {onPoseSearch && (
                  <Pressable onPress={() => onPoseSearch(item.id)} hitSlop={8}>
                    <Text style={DS.action}>＊ pose search</Text>
                  </Pressable>
                )}
                {onTrash && (
                  <Pressable hitSlop={8}
                    onPress={() => Alert.alert('删除该图片', '将移入回收站', [
                      { text: '取消', style: 'cancel' },
                      { text: '删除', style: 'destructive', onPress: () => onTrash(item.id) },
                    ])}
                  >
                    <Text style={DS.actionDanger}>× delete</Text>
                  </Pressable>
                )}
              </XStack>
              <Pressable onPress={onClose} hitSlop={8}>
                <Text style={DS.actionClose}>close</Text>
              </Pressable>
            </XStack>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}


// --- DetailModal styles (Editorial atelier) ---
// Typography pairs platform serif (Georgia on iOS, Noto Serif on Android) at
// italic for "voice" elements (title, hints, actions) with platform monospace
// (Menlo / monospace) for archival metadata. Body falls through to Tamagui /
// system sans. Lavender #b388ff is the only colored accent and earns its
// presence by appearing only on active state.

const DS = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(28, 26, 23, 0.45)' },
  sheet: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    backgroundColor: '#fcfaf6',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '92%',
  },
  handle: {
    width: 48, height: 3,
    borderRadius: 1.5,
    backgroundColor: '#d6d0c4',
  },
  imageFrame: {
    backgroundColor: '#efebe3',
    borderRadius: 4,
    overflow: 'hidden',
    alignSelf: 'center',
  },
  expandHint: {
    fontFamily: Platform.select({ ios: 'Georgia', android: 'serif' }),
    fontSize: 12,
    fontStyle: 'italic',
    color: '#8a8278',
    letterSpacing: 0.2,
  },
  title: {
    fontFamily: Platform.select({ ios: 'Georgia', android: 'serif' }),
    fontSize: 28,
    fontStyle: 'italic',
    lineHeight: 34,
    color: '#1c1a17',
    marginBottom: 8,
  },
  meta: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 10,
    color: '#8a8278',
    letterSpacing: 1.4,
  },
  sectionLabel: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 9,
    color: '#a8a195',
    letterSpacing: 2.4,
    marginBottom: 14,
  },
  hairline: {
    height: 1,
    backgroundColor: '#e6e1d8',
  },
  body: {
    fontSize: 14,
    color: '#3a342c',
    lineHeight: 22,
  },
  placeholder: {
    fontFamily: Platform.select({ ios: 'Georgia', android: 'serif' }),
    fontSize: 14,
    color: '#bcb6aa',
    fontStyle: 'italic',
  },
  tag: {
    fontSize: 14,
    color: '#1c1a17',
    textDecorationLine: 'underline',
    textDecorationColor: '#b388ff',
  },
  tagAdd: {
    fontSize: 14,
    color: '#b388ff',
  },
  url: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 11,
    color: '#7a73a5',
    letterSpacing: 0.3,
    lineHeight: 18,
  },
  action: {
    fontFamily: Platform.select({ ios: 'Georgia', android: 'serif' }),
    fontSize: 15,
    color: '#1c1a17',
    fontStyle: 'italic',
  },
  actionDanger: {
    fontFamily: Platform.select({ ios: 'Georgia', android: 'serif' }),
    fontSize: 15,
    color: '#9a3a3a',
    fontStyle: 'italic',
  },
  actionClose: {
    fontFamily: Platform.select({ ios: 'Georgia', android: 'serif' }),
    fontSize: 15,
    color: '#b388ff',
    fontStyle: 'italic',
  },
});

