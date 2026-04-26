import {
  Pressable, Image, Dimensions, Modal, ScrollView, FlatList,
  BackHandler, Platform,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { YStack, XStack, Text, Spinner, Button, Input } from 'tamagui';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { useFocusEffect } from 'expo-router';
import { remoteWS, RemoteMessage } from '../../utils/websocket';
import ImageZoom from 'react-native-image-pan-zoom';

// --- Types ---

type EagleFolder = {
  id: string; name: string;
  count?: number;
  imageCount?: number;
  folderCount?: number;
};

type EagleItem = {
  id: string; name: string; ext: string;
  width: number; height: number;
  tags: string[]; star: number;
  annotation: string; url: string; size: number;
};

// --- Constants ---

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;
const GAP = 4;
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
  const [connected, setConnected] = useState(remoteWS.getState() === 'connected');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [items, setItems] = useState<EagleItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [error, setError] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbRequested = useRef<Set<string>>(new Set());
  const [detailItem, setDetailItem] = useState<EagleItem | null>(null);
  const [fileServerUrl, setFileServerUrl] = useState<string | null>(null);

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [folders, setFolders] = useState<EagleFolder[]>([]);
  const [allTags, setAllTags] = useState<{ name: string; count: number }[]>([]);
  const [activeFolder, setActiveFolder] = useState<EagleFolder | null>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [activeRating, setActiveRating] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => remoteWS.onStateChange(s => setConnected(s === 'connected')), []);

  // Current search params (for loadMore)
  const searchParamsRef = useRef({
    keyword: '', tags: [] as string[], rating: 0, folderId: '',
  });

  // Android back button
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (detailItem) { setDetailItem(null); return true; }
        if (tagPickerOpen) { setTagPickerOpen(false); return true; }
        if (filterOpen) { setFilterOpen(false); return true; }
        if (searchQuery || activeTags.length || activeRating || activeFolder) {
          clearAllFilters(); return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [detailItem, filterOpen, tagPickerOpen, searchQuery, activeTags.length, activeRating, activeFolder])
  );

  // Probe file server
  const probeFileServers = useCallback(async (urls: string[]) => {
    for (const url of urls) {
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 2000);
        const r = await fetch(`${url}/health`, { signal: c.signal });
        clearTimeout(t);
        if (r.ok) { setFileServerUrl(url); return; }
      } catch (_) {}
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
        const d = msg.data as { folders?: EagleFolder[] };
        if (d.folders) setFolders(d.folders);
      }
      if (msg.action === 'eagle_tags') {
        const d = msg.data as { tags?: { name: string; count: number }[] };
        if (d.tags) setAllTags(d.tags);
      }
      if (msg.action === 'eagle_search' || msg.action === 'eagle_recent' || msg.action === 'eagle_items') {
        setLoading(false); setLoadingMore(false);
        const d = msg.data as {
          items?: EagleItem[]; total?: number; offset?: number; error?: string;
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
        const d = msg.data as { success?: boolean; message?: string; items?: EagleItem[] };
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
    });
    return unsub;
  }, []);

  // LAN thumbnails
  useEffect(() => {
    if (!fileServerUrl || items.length === 0) return;
    const batch: Record<string, string> = {};
    for (const it of items) batch[it.id] = `${fileServerUrl}/thumb/${it.id}`;
    setThumbs(prev => ({ ...prev, ...batch }));
  }, [fileServerUrl, items]);

  // WAN thumbnails fallback
  useEffect(() => {
    if (fileServerUrl) return;
    for (const it of items) {
      if (thumbRequested.current.has(it.id)) continue;
      thumbRequested.current.add(it.id);
      remoteWS.requestEagleThumbnail(it.id);
    }
  }, [items, fileServerUrl]);

  // Initial load
  useFocusEffect(useCallback(() => {
    if (!connected) return;
    if (!fileServerUrl) remoteWS.requestStatus();
    if (items.length === 0 && !loading) doSearch({});
    if (folders.length === 0) remoteWS.requestEagleFolders();
    if (allTags.length === 0) remoteWS.requestEagleTags();
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
    remoteWS.requestEagleSearch({ ...params, offset: 0, limit: PAGE_SIZE });
  }, []);

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
    folder: EagleFolder | null, tags: string[], rating: number,
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

  const selectFolder = (f: EagleFolder | null) => {
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
    remoteWS.requestEaglePoseSearch({ refItemId });
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
    remoteWS.requestEagleSearch({
      ...searchParamsRef.current,
      offset: itemsRef.current.length,
      limit: PAGE_SIZE,
    });
  }, []);

  const renderCell = useCallback(({ item }: { item: EagleItem }) => (
    <MemoCell item={item} thumb={thumbs[item.id]} onPress={() => setDetailItem(item)} />
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [thumbs]);

  if (!connected) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#f5f5f7' }}>
        <YStack padding="$4"><Text fontSize={28} fontWeight="700" color="#1d1d1f">素材库</Text></YStack>
        <YStack flex={1} justifyContent="center" alignItems="center" gap="$3">
          <YStack width={80} height={80} borderRadius={40} backgroundColor="#f0f0f0"
            justifyContent="center" alignItems="center">
            <MaterialCommunityIcons name="lan-disconnect" size={36} color="#ccc" />
          </YStack>
          <Text color="#999" fontSize={16}>桌面端未连接</Text>
          <Text color="#bbb" fontSize={13} textAlign="center" lineHeight={20}>
            {'请在电脑上打开 Nephele\n并确保 Eagle 正在运行'}
          </Text>
        </YStack>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#f5f5f7' }}>
      {/* Search bar */}
      <XStack paddingHorizontal={12} paddingTop={10} paddingBottom={4} gap={8} alignItems="center">
        <XStack flex={1} backgroundColor="#fff" borderRadius={10} paddingLeft={10}
          alignItems="center" borderWidth={1} borderColor={searchQuery ? '#b388ff' : '#e8e8e8'}>
          <MaterialCommunityIcons name="magnify" size={18} color="#999" />
          <Input flex={1} placeholder="搜索名称、备注..." value={searchQuery}
            onChangeText={onSearchChange} backgroundColor="transparent" borderWidth={0}
            color="#1d1d1f" fontSize={14} height={36}
            placeholderTextColor="#bbb" returnKeyType="search" />
          {searchQuery ? (
            <Pressable onPress={() => onSearchChange('')} style={{ paddingRight: 8 }}>
              <MaterialCommunityIcons name="close-circle" size={16} color="#ccc" />
            </Pressable>
          ) : null}
        </XStack>
        <Pressable onPress={() => doSearch(searchParamsRef.current)}>
          <MaterialCommunityIcons name="refresh" size={20} color="#b388ff" />
        </Pressable>
      </XStack>

      {/* Filter chips row */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ paddingHorizontal: 12, gap: 6, paddingBottom: 6 }}>
        {/* Folder filter */}
        <Pressable onPress={() => setFilterOpen(true)}>
          <FilterChip label={activeFolder ? activeFolder.name : '文件夹'} active={!!activeFolder}
            icon="folder" />
        </Pressable>
        {/* Tag filter */}
        <Pressable onPress={() => setTagPickerOpen(true)}>
          <FilterChip
            label={activeTags.length ? activeTags.join(', ') : '标签'}
            active={activeTags.length > 0} icon="tag" />
        </Pressable>
        {/* Rating filter */}
        {[3, 4, 5].map(r => (
          <Pressable key={r} onPress={() => setRating(r)}>
            <FilterChip label={`${r}+`} active={activeRating === r} icon="star" />
          </Pressable>
        ))}
        {/* Clear all */}
        {hasAnyFilter && (
          <Pressable onPress={clearAllFilters}>
            <XStack backgroundColor="#fff3f3" borderRadius={16} paddingHorizontal={10}
              paddingVertical={5} alignItems="center" gap={4}>
              <MaterialCommunityIcons name="close" size={14} color="#cc4444" />
              <Text fontSize={12} color="#cc4444">清除</Text>
            </XStack>
          </Pressable>
        )}
      </ScrollView>

      {/* Count */}
      <XStack paddingHorizontal={12} paddingBottom={2}>
        <Text fontSize={11} color="#999">
          {totalItems > 0 ? `${totalItems} 张图片` : ''}
        </Text>
      </XStack>

      {error ? (
        <YStack marginHorizontal="$4" marginBottom="$2" backgroundColor="#fff3f3"
          borderRadius="$3" padding="$2.5">
          <Text color="#cc4444" fontSize={13}>{error}</Text>
        </YStack>
      ) : null}

      {loading ? (
        <YStack flex={1} justifyContent="center" alignItems="center">
          <Spinner size="large" color="#b388ff" />
        </YStack>
      ) : (
        <FlashList
          data={items}
          extraData={thumbs}
          numColumns={2}
          masonry
          renderItem={renderCell}
          estimatedItemSize={COL_W}
          overrideItemLayout={(layout, item) => {
            const ar = item.width && item.height ? item.width / item.height : 1;
            layout.size = Math.min(COL_W / ar, COL_W * 2.5) + INFO_H + GAP;
          }}
          contentContainerStyle={{ paddingHorizontal: PAD, paddingBottom: 20 }}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
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
      />

      {/* Tag picker sheet */}
      <TagPickerSheet
        visible={tagPickerOpen}
        tags={allTags}
        activeTags={activeTags}
        onToggle={toggleTag}
        onClose={() => setTagPickerOpen(false)}
      />

      {/* Detail Modal */}
      <DetailModal item={detailItem} thumb={detailItem ? thumbs[detailItem.id] : undefined}
        fileServerUrl={fileServerUrl} onClose={() => setDetailItem(null)}
        onPoseSearch={doPoseSearch} />
    </SafeAreaView>
  );
}

// --- Folder filter bottom sheet ---

function FolderFilterSheet({ visible, folders, activeId, onSelect, onClose }: {
  visible: boolean; folders: EagleFolder[];
  activeId: string | null;
  onSelect: (f: EagleFolder | null) => void;
  onClose: () => void;
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
          <Text fontSize={17} fontWeight="600" color="#1d1d1f" paddingHorizontal={16} marginBottom={8}>
            按文件夹筛选
          </Text>

          <FlatList
            style={{ maxHeight: SCREEN_H * 0.55 }}
            data={folders}
            keyExtractor={f => f.id}
            initialNumToRender={15}
            maxToRenderPerBatch={10}
            getItemLayout={(_, i) => ({ length: 44, offset: 44 * (i + 1), index: i })}
            ListHeaderComponent={
              <Pressable onPress={() => onSelect(null)}>
                <XStack paddingHorizontal={16} paddingVertical={12} alignItems="center" gap={12}
                  backgroundColor={activeId === null ? '#f8f0ff' : 'transparent'}>
                  <MaterialCommunityIcons name="image-multiple" size={20}
                    color={activeId === null ? '#b388ff' : '#999'} />
                  <Text flex={1} fontSize={15} color={activeId === null ? '#b388ff' : '#1d1d1f'}
                    fontWeight={activeId === null ? '600' : '400'}>全部图片</Text>
                  {activeId === null && <MaterialCommunityIcons name="check" size={18} color="#b388ff" />}
                </XStack>
              </Pressable>
            }
            renderItem={({ item: f }) => {
              const isActive = f.id === activeId;
              const imgCount = f.imageCount ?? f.count ?? 0;
              return (
                <Pressable onPress={() => onSelect(f)}>
                  <XStack paddingHorizontal={16} paddingVertical={12} alignItems="center" gap={12}
                    backgroundColor={isActive ? '#f8f0ff' : 'transparent'}>
                    <MaterialCommunityIcons name="folder" size={20}
                      color={isActive ? '#b388ff' : '#999'} />
                    <Text flex={1} fontSize={15} color={isActive ? '#b388ff' : '#1d1d1f'}
                      fontWeight={isActive ? '600' : '400'} numberOfLines={1}>{f.name}</Text>
                    <Text fontSize={12} color="#bbb">{imgCount > 0 ? imgCount : ''}</Text>
                    {isActive && <MaterialCommunityIcons name="check" size={18} color="#b388ff" />}
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

function FilterChip({ label, active, icon }: { label: string; active: boolean; icon: string }) {
  return (
    <XStack backgroundColor={active ? '#f0e6ff' : '#fff'}
      borderRadius={16} paddingHorizontal={10} paddingVertical={5}
      alignItems="center" gap={4}
      borderWidth={1} borderColor={active ? '#b388ff' : '#e8e8e8'}>
      <MaterialCommunityIcons name={icon as any} size={14}
        color={active ? '#b388ff' : '#999'} />
      <Text fontSize={12} color={active ? '#b388ff' : '#666'} numberOfLines={1} maxWidth={120}>
        {label}
      </Text>
    </XStack>
  );
}

// --- Tag Picker Sheet ---

function TagPickerSheet({ visible, tags, activeTags, onToggle, onClose }: {
  visible: boolean;
  tags: { name: string; count: number }[];
  activeTags: string[];
  onToggle: (tag: string) => void;
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
            maxHeight: '70%',
            paddingBottom: insets.bottom || 16,
          }}
          onPress={e => e.stopPropagation()}
        >
          <YStack alignItems="center" paddingVertical={10}>
            <YStack width={36} height={4} borderRadius={2} backgroundColor="#ddd" />
          </YStack>
          <Text fontSize={17} fontWeight="600" color="#1d1d1f" paddingHorizontal={16} marginBottom={4}>
            按标签筛选
          </Text>

          {/* Active tags */}
          {activeTags.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 16, gap: 6, paddingBottom: 8 }}>
              {activeTags.map(t => (
                <Pressable key={t} onPress={() => onToggle(t)}>
                  <XStack backgroundColor="#f0e6ff" borderRadius={12} paddingHorizontal={10}
                    paddingVertical={4} alignItems="center" gap={4}>
                    <Text fontSize={12} color="#b388ff">{t}</Text>
                    <MaterialCommunityIcons name="close" size={12} color="#b388ff" />
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
                    <MaterialCommunityIcons name={isActive ? 'checkbox-marked' : 'checkbox-blank-outline'}
                      size={20} color={isActive ? '#b388ff' : '#ccc'} />
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

// Full image URL cache
const fullImageCache = new Map<string, string>();

// --- Grid Cell (memo + thumb via ref to avoid re-render cascade) ---

function CellInner({ item, thumb, onPress }: {
  item: EagleItem; thumb?: string; onPress: () => void;
}) {
  const ar = item.width && item.height ? item.width / item.height : 1;
  const h = Math.min(COL_W / ar, COL_W * 2.5);
  return (
    <Pressable style={{ marginBottom: GAP, marginHorizontal: GAP / 2 }} onPress={onPress}>
      <YStack backgroundColor="#fff" borderRadius={6} overflow="hidden">
        <YStack height={h} backgroundColor="#f0f0f0" justifyContent="center" alignItems="center">
          {thumb
            ? <Image source={{ uri: thumb }} style={{ width: '100%', height: h }} resizeMode="cover" />
            : <MaterialCommunityIcons name="image-outline" size={24} color="#ddd" />}
        </YStack>
        <XStack padding={4} paddingHorizontal={6} alignItems="center" justifyContent="space-between">
          <Text color="#999" fontSize={10} numberOfLines={1} flex={1}>{item.name}</Text>
          {item.star > 0 && (
            <XStack alignItems="center" gap={2} marginLeft={4}>
              <MaterialCommunityIcons name="star" size={10} color="#f7b500" />
              <Text color="#f7b500" fontSize={10}>{item.star}</Text>
            </XStack>
          )}
        </XStack>
      </YStack>
    </Pressable>
  );
}

const MemoCell = memo(CellInner);

// --- Detail Modal ---

function DetailModal({ item, thumb, fileServerUrl, onClose, onPoseSearch }: {
  item: EagleItem | null; thumb?: string; fileServerUrl: string | null;
  onClose: () => void; onPoseSearch?: (itemId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [fullImageUrl, setFullImageUrl] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState('');

  useEffect(() => {
    setLightboxOpen(false); setLoadingFull(false); setFullError('');
    if (item?.id && fullImageCache.has(item.id)) setFullImageUrl(fullImageCache.get(item.id)!);
    else setFullImageUrl(null);
  }, [item?.id]);

  useEffect(() => {
    if (!item) return;
    const unsub = remoteWS.onMessage((msg: RemoteMessage) => {
      if (msg.type !== 'event' || msg.action !== 'eagle_full_image' || !msg.data) return;
      const d = msg.data as { itemId?: string; url?: string; error?: string };
      if (d.itemId !== item.id) return;
      setLoadingFull(false);
      if (d.error) setFullError(d.error);
      else if (d.url) {
        fullImageCache.set(item.id, d.url);
        setFullImageUrl(d.url);
        setLightboxOpen(true);
      }
    });
    return unsub;
  }, [item?.id]);

  const openLightbox = () => {
    if (!item) return;
    if (fullImageUrl) { setLightboxOpen(true); return; }
    setLoadingFull(true); setFullError('');
    if (fileServerUrl) {
      const url = `${fileServerUrl}/full/${item.id}`;
      fullImageCache.set(item.id, url);
      setFullImageUrl(url); setLoadingFull(false); setLightboxOpen(true);
    } else {
      remoteWS.requestEagleFullImage(item.id);
    }
  };

  if (!item) return null;
  const ar = item.width && item.height ? item.width / item.height : 1;
  const imgW = SCREEN_W - 32;
  const imgH = Math.min(imgW / ar, 500);

  return (
    <>
      <Modal visible animationType="slide" transparent onRequestClose={onClose}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
          <Pressable
            style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              backgroundColor: '#fff',
              borderTopLeftRadius: 20, borderTopRightRadius: 20,
              maxHeight: '90%',
              paddingBottom: insets.bottom || 20,
            }}
            onPress={e => e.stopPropagation()}
          >
            <YStack alignItems="center" paddingVertical={10}>
              <YStack width={36} height={4} borderRadius={2} backgroundColor="#ddd" />
            </YStack>

            <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0 }}>
              <Pressable onPress={openLightbox}>
                <YStack width={imgW} height={imgH} backgroundColor="#f0f0f0"
                  borderRadius={12} overflow="hidden" alignSelf="center" marginBottom={4}>
                  {thumb
                    ? <Image source={{ uri: thumb }} style={{ width: imgW, height: imgH }} resizeMode="contain" />
                    : <YStack flex={1} justifyContent="center" alignItems="center"><Spinner size="small" color="#b388ff" /></YStack>}
                  {loadingFull && (
                    <YStack position="absolute" top={0} left={0} right={0} bottom={0}
                      backgroundColor="rgba(0,0,0,0.3)" justifyContent="center" alignItems="center">
                      <Spinner size="small" color="#fff" />
                      <Text color="#fff" fontSize={12} marginTop={6}>正在拉取原图...</Text>
                    </YStack>
                  )}
                </YStack>
              </Pressable>

              <XStack justifyContent="center" marginBottom={12}>
                {fullError ? (
                  <Text fontSize={11} color="#cc4444">{fullError}</Text>
                ) : (
                  <Pressable onPress={openLightbox}>
                    <XStack alignItems="center" gap={4}>
                      <MaterialCommunityIcons name="arrow-expand-all" size={13} color="#b388ff" />
                      <Text fontSize={11} color="#b388ff">
                        {loadingFull ? '传输中...' : fullImageUrl ? '查看原图' : '点击查看原图'}
                      </Text>
                    </XStack>
                  </Pressable>
                )}
              </XStack>

              <Text fontSize={18} fontWeight="700" color="#1d1d1f" marginBottom={4}>{item.name}</Text>
              <Text fontSize={13} color="#999" marginBottom={12}>
                {item.ext?.toUpperCase()} · {item.width} x {item.height} · {fmtSize(item.size)}
              </Text>

              {item.star > 0 && (
                <XStack alignItems="center" gap={6} marginBottom={12}>
                  {[1, 2, 3, 4, 5].map(i => (
                    <MaterialCommunityIcons key={i}
                      name={i <= item.star ? 'star' : 'star-outline'}
                      size={20} color={i <= item.star ? '#f7b500' : '#ddd'} />
                  ))}
                </XStack>
              )}

              {item.tags.length > 0 && (
                <YStack marginBottom={12}>
                  <Text fontSize={13} fontWeight="600" color="#1d1d1f" marginBottom={6}>标签</Text>
                  <XStack flexWrap="wrap" gap={6}>
                    {item.tags.map(t => (
                      <Text key={t} fontSize={12} color="#b388ff" backgroundColor="#f5f0ff"
                        paddingHorizontal={8} paddingVertical={4} borderRadius={6}>{t}</Text>
                    ))}
                  </XStack>
                </YStack>
              )}

              {item.annotation ? (
                <YStack marginBottom={12}>
                  <Text fontSize={13} fontWeight="600" color="#1d1d1f" marginBottom={4}>备注</Text>
                  <Text fontSize={13} color="#666" lineHeight={20}>{item.annotation}</Text>
                </YStack>
              ) : null}

              {item.url ? (
                <YStack marginBottom={12}>
                  <Text fontSize={13} fontWeight="600" color="#1d1d1f" marginBottom={4}>来源</Text>
                  <Text fontSize={12} color="#b388ff" numberOfLines={2}>{item.url}</Text>
                </YStack>
              ) : null}

              <XStack gap={8} marginTop={8}>
                {onPoseSearch && (
                  <Button flex={1} size="$4" backgroundColor="#fff0f5" borderRadius={12}
                    pressStyle={{ opacity: 0.7 }} onPress={() => item && onPoseSearch(item.id)}>
                    <XStack alignItems="center" gap={4}>
                      <MaterialCommunityIcons name="human-handsup" size={16} color="#e91e63" />
                      <Text color="#e91e63" fontWeight="600" fontSize={13}>姿势搜索</Text>
                    </XStack>
                  </Button>
                )}
                <Button flex={1} size="$4" backgroundColor="#f5f0ff" borderRadius={12}
                  pressStyle={{ opacity: 0.7 }} onPress={onClose}>
                  <Text color="#b388ff" fontWeight="600">关闭</Text>
                </Button>
              </XStack>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <FullscreenLightbox
        visible={lightboxOpen} imageUrl={fullImageUrl}
        width={item.width} height={item.height}
        onClose={() => setLightboxOpen(false)}
      />
    </>
  );
}

// --- Fullscreen Lightbox ---

function FullscreenLightbox({ visible, imageUrl, width, height, onClose }: {
  visible: boolean; imageUrl: string | null;
  width: number; height: number; onClose: () => void;
}) {
  if (!visible || !imageUrl) return null;
  const ar = width && height ? width / height : 1;
  const fitH = SCREEN_W / ar;
  const imgH = Math.min(fitH, SCREEN_H);
  const imgW = imgH === SCREEN_H ? SCREEN_H * ar : SCREEN_W;

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <YStack flex={1} backgroundColor="#000">
        {/* @ts-ignore */}
        <ImageZoom cropWidth={SCREEN_W} cropHeight={SCREEN_H}
          imageWidth={imgW} imageHeight={imgH}
          minScale={1} maxScale={6} enableDoubleClickZoom doubleClickInterval={300}>
          <Image source={{ uri: imageUrl }} style={{ width: imgW, height: imgH }} resizeMode="contain" />
        </ImageZoom>

        <Pressable onPress={onClose}
          style={{
            position: 'absolute', top: 50, right: 20,
            width: 40, height: 40, borderRadius: 20,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'center', alignItems: 'center',
          }}>
          <MaterialCommunityIcons name="close" size={22} color="#fff" />
        </Pressable>

        <YStack position="absolute" bottom={50} alignSelf="center"
          backgroundColor="rgba(0,0,0,0.5)" paddingHorizontal={12} paddingVertical={4}
          borderRadius={12} pointerEvents="none">
          <Text color="rgba(255,255,255,0.7)" fontSize={11}>
            {width} x {height} · 双指缩放
          </Text>
        </YStack>
      </YStack>
    </Modal>
  );
}
