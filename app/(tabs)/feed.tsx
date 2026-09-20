import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, RefreshControl, useWindowDimensions } from 'react-native';
import { YStack, XStack, Text, Spinner } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { Rss, FolderPlus, Check, RotateCcw, ChevronLeft, Sparkles, UserCog } from 'lucide-react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { colors } from '../../theme/colors';
import { TAB_BAR_CLEARANCE } from '../../components/FloatingTabBar';
import {
  fetchInbox, fetchTrending, fetchPixivisionArticle,
  type FeedItem, type TrendingMode,
} from '../../utils/subscriptions';
import { remoteWS } from '../../utils/websocket';
import { AuraDialog } from '../../components/AuraDialog';
import { useLightboxControls, type ImageSource as LbImageSource } from '../../components/Lightbox';
import analytics from '../../utils/analytics';
import { standardImageActions } from '../../utils/lightboxActions';

type Status = 'loading' | 'ready' | 'error' | 'disabled';
type SaveState = 'idle' | 'saving' | 'saved' | 'failed';
type Tab = 'follow' | 'discover';
type DiscoverFilter = TrendingMode | 'pixivision';

// 2-column masonry geometry — mirrors the gallery grid (index.tsx) so the feed
// reads as the same compact, aspect-ratio-aware tile grid rather than a
// full-width forced-square stream (which crop-jumps on cell recycle).
const GAP = 6;
const PAD = 12;
// Column count follows the LIVE window width (rotation / tablets), 2 minimum.
const TARGET_COL_W = 210;
const colsFor = (winW: number) => Math.max(2, Math.floor(winW / TARGET_COL_W));
const colWidthFor = (cols: number, winW: number) => (winW - PAD * 2 - GAP * (cols - 1)) / cols;

const DISCOVER_FILTERS: { key: DiscoverFilter; label: string }[] = [
  { key: 'daily', label: '日榜' },
  { key: 'weekly', label: '周榜' },
  { key: 'monthly', label: '月榜' },
  { key: 'pixivision', label: '特辑' },
];

function relTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() / 1000 - ts;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(ts * 1000).toLocaleDateString();
}

function feedKey(it: FeedItem): string {
  return it.kind === 'article' ? `a${it.article_id}` : `${it.source}:${it.illust_id || it.page_url}`;
}

// Drop duplicate feedKeys, keeping the first occurrence. A subscription inbox
// can hold both a backfill snapshot and a later new-post entry for the SAME
// illust → identical feedKey. Without this, FlashList's keyExtractor +
// expo-image recyclingKey collide and the duplicate cell renders blank. Inbox
// is sorted newest-first, so the kept entry is the newer "新作" over the
// older "订阅时" snapshot.
function dedupeByKey(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const it of items) {
    const k = feedKey(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// Source badge — distinguishes a subscription new-post / subscribe-time snapshot
// / ranking position / pixivision spotlight (mirrors desktop FeedPostCard).
function badgeFor(it: FeedItem): { text: string; tint: string } {
  if (it.source === 'ranking') return { text: it.rank ? `#${it.rank}` : '排行', tint: '#E8B44A' };
  if (it.source === 'pixivision') return { text: '特辑', tint: colors.brand.primary };
  if (it.backfill) return { text: '订阅时', tint: colors.text.tertiary };
  return { text: '新作', tint: colors.status.success };
}

// Cell height from intrinsic dims → real masonry with NO onLoad measure pass
// (an onLoad-driven height would relayout recycled cells mid-scroll = flicker,
// see project_aura_gallery_transition_flicker). Square fallback when dims are
// unknown (inbox / pixivision items don't carry them).
function cellHeight(it: FeedItem, colW: number): number {
  if (it.kind === 'article') return Math.round(colW * 0.62) + 2;   // 16:10-ish banner
  const ar = it.width && it.height ? it.width / it.height : 1;
  return Math.round(Math.min(Math.max(colW / ar, colW * 0.62), colW * 1.9));
}

const FeedCell = memo(function FeedCell({ item, state, colW, onSave, onOpen }: {
  item: FeedItem; state: SaveState; colW: number;
  onSave: (item: FeedItem) => void; onOpen: (item: FeedItem) => void;
}) {
  const h = cellHeight(item, colW);
  const isArticle = item.kind === 'article';
  const badge = badgeFor(item);

  return (
    <Pressable
      onPress={() => onOpen(item)}
      style={({ pressed }) => ({ marginBottom: GAP, marginHorizontal: GAP / 2, opacity: pressed ? 0.75 : 1 })}
    >
      <YStack borderRadius={12} overflow="hidden" backgroundColor={colors.bg.thumb}>
        <YStack height={h}>
          <Image
            source={{ uri: item.thumb_proxied }}
            style={{ width: '100%', height: h }}
            contentFit="cover"
            transition={0}              // FlashList recycle + fade = scroll flicker
            cachePolicy="memory-disk"
            // When a recycled cell rebinds to a new item, reset the view so the
            // previous item's bitmap doesn't linger until the new one loads
            // (the "shows image A then jumps to B on scroll" bug). We have no
            // blurhash placeholder to cover the gap (unlike the gallery cell),
            // so the container's bg.thumb shows briefly instead. transition={0}
            // means no reveal animation, so this doesn't reintroduce the
            // gallery's old recyclingKey "load-then-disappear" flicker.
            recyclingKey={feedKey(item)}
          />

          {/* Source badge (top-left) */}
          <XStack position="absolute" top={6} left={6}
            backgroundColor="rgba(0,0,0,0.58)" borderRadius={6}
            borderWidth={1} borderColor={badge.tint + 'b3'}
            paddingHorizontal={6} paddingVertical={2} alignItems="center">
            <Text fontSize={9} fontWeight="700" color={badge.tint}>{badge.text}</Text>
          </XStack>

          {/* Save-to-library (illusts only — article cards drill in instead) */}
          {!isArticle && (
            <Pressable onPress={() => onSave(item)} hitSlop={6}
              disabled={state === 'saving' || state === 'saved'}
              style={{ position: 'absolute', top: 6, right: 6 }}>
              <XStack height={28} borderRadius={14} alignItems="center" gap={3}
                paddingHorizontal={state === 'idle' ? 0 : 8}
                width={state === 'idle' ? 28 : undefined}
                justifyContent="center"
                backgroundColor="rgba(26,20,56,0.66)" borderWidth={1}
                borderColor={state === 'saved' ? colors.status.success
                  : state === 'failed' ? colors.status.danger : 'rgba(206,172,224,0.3)'}>
                {state === 'saving' ? (
                  <Spinner size="small" color={colors.brand.primary} />
                ) : state === 'saved' ? (
                  <Check size={15} color={colors.status.success} />
                ) : state === 'failed' ? (
                  <RotateCcw size={14} color={colors.status.danger} />
                ) : (
                  <FolderPlus size={15} color={colors.text.primary} />
                )}
              </XStack>
            </Pressable>
          )}

          {/* Bookmark count (ranking only, bottom-right) */}
          {item.source === 'ranking' && (item.bookmark_count ?? 0) > 0 && (
            <XStack position="absolute" bottom={6} right={6}
              backgroundColor="rgba(0,0,0,0.58)" borderRadius={6}
              paddingHorizontal={6} paddingVertical={2}>
              <Text fontSize={9} color="#FFFFFF">收藏 {item.bookmark_count}</Text>
            </XStack>
          )}

          {/* Article cards: title overlay (gradient-less scrim) at the bottom */}
          {isArticle && !!item.title && (
            <YStack position="absolute" left={0} right={0} bottom={0}
              backgroundColor="rgba(26,20,56,0.72)" paddingHorizontal={8} paddingVertical={6}>
              <Text fontSize={11} fontWeight="600" color={colors.text.primary} numberOfLines={2}>
                {item.title}
              </Text>
            </YStack>
          )}
        </YStack>

        {/* Caption row (illusts only) — artist + relative time / nothing */}
        {!isArticle && (
          <XStack paddingHorizontal={8} paddingVertical={6} alignItems="center" gap={6}>
            <Text flex={1} color={colors.text.secondary} fontSize={11} fontWeight="600" numberOfLines={1}>
              {item.user_name || '未知画师'}
            </Text>
            {item.source === 'subscription' && !!item.ts && (
              <Text color={colors.text.faint} fontSize={10}>{relTime(item.ts)}</Text>
            )}
          </XStack>
        )}
      </YStack>
    </Pressable>
  );
});

function CenterState({ children }: { children: React.ReactNode }) {
  return (
    <YStack flex={1} justifyContent="center" alignItems="center" gap={14} paddingBottom={TAB_BAR_CLEARANCE}>
      {children}
    </YStack>
  );
}

function SegTab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ flex: 1 }}>
      <YStack height={34} borderRadius={9} justifyContent="center" alignItems="center"
        backgroundColor={active ? colors.brand.soft : 'transparent'}>
        <Text fontSize={14} fontWeight={active ? '700' : '500'}
          color={active ? colors.text.primary : colors.text.tertiary}>{label}</Text>
      </YStack>
    </Pressable>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      <XStack backgroundColor={active ? colors.brand.primary : colors.bg.surface}
        borderRadius={15} paddingHorizontal={13} paddingVertical={6} alignItems="center">
        <Text fontSize={12} fontWeight={active ? '700' : '500'}
          color={active ? colors.bg.canvas : colors.text.secondary}>{label}</Text>
      </XStack>
    </Pressable>
  );
}

export default function FeedScreen() {
  const router = useRouter();
  const { width: winW } = useWindowDimensions();
  const cols = colsFor(winW);
  const colW = colWidthFor(cols, winW);
  const [tab, setTab] = useState<Tab>('follow');
  const [discoverFilter, setDiscoverFilter] = useState<DiscoverFilter>('daily');
  const [article, setArticle] = useState<{ id: string; title: string } | null>(null);

  const [items, setItems] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [confirmItem, setConfirmItem] = useState<FeedItem | null>(null);

  const [desktopOnline, setDesktopOnline] = useState(() => remoteWS.getDesktopOnline());
  const desktopOnlineRef = useRef(desktopOnline);
  desktopOnlineRef.current = desktopOnline;
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const itemsRef = useRef(items);   // stable read for the (memoized) tap handler
  itemsRef.current = items;

  const { openLightbox } = useLightboxControls();

  const reqMap = useRef<Record<string, string>>({});     // requestId → illust_id
  const reqToken = useRef(0);                             // guards against stale-response overwrite
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => remoteWS.onDesktopStateChange(setDesktopOnline), []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  // Desktop import outcome → real per-card state (not optimistic), matched via requestId.
  useEffect(() => {
    const unsub = remoteWS.onMessage((msg) => {
      if (msg.type !== 'event' || msg.action !== 'eagle_batch_import_result' || !msg.data) return;
      const d = msg.data as { requestId?: string; success?: boolean; processed?: number };
      const reqId = d.requestId || '';
      const illustId = reqId && reqMap.current[reqId];
      if (!illustId) return;
      delete reqMap.current[reqId];
      const ok = !!d.success || (d.processed ?? 0) > 0;
      setSaveState((s) => ({ ...s, [illustId]: ok ? 'saved' : 'failed' }));
      showToast(ok ? '已存入桌面库' : '入库失败，点重试');
    });
    return unsub;
  }, [showToast]);

  // --- Loading: tab / filter / article all route through one fetch. A token
  // guards against a slow earlier request overwriting a newer selection. ---
  const load = useCallback(async (isRefresh: boolean) => {
    if (!isRefresh) setStatus('loading');
    const token = ++reqToken.current;
    let res;
    if (tab === 'follow') {
      res = await fetchInbox(false);
    } else if (article) {
      res = await fetchPixivisionArticle(article.id);
    } else if (discoverFilter === 'pixivision') {
      res = await fetchTrending('pixivision');
    } else {
      res = await fetchTrending('ranking', discoverFilter);
    }
    if (token !== reqToken.current) return;   // a newer load supersedes this one
    if (res.featureDisabled) { setStatus('disabled'); setItems([]); return; }
    if (!res.success) { setStatus('error'); return; }
    setItems(dedupeByKey(res.items));
    setStatus('ready');
  }, [tab, discoverFilter, article]);

  // Reload whenever the surface changes; also refresh on focus.
  useFocusEffect(useCallback(() => {
    analytics.capture('feed_viewed', { tab });
    void load(false);
  }, [load, tab]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  // Tap → open. Article cards drill into their illusts; illust cells open the
  // original-image lightbox (same viewer as 素材库), swiping across the feed —
  // NOT a jump to the external page.
  const onOpen = useCallback((item: FeedItem) => {
    if (item.kind === 'article' && item.article_id) {
      analytics.capture('pixivision_article_opened', { article_id: item.article_id });
      setArticle({ id: item.article_id, title: item.title });
      return;
    }
    const illusts = itemsRef.current.filter((it) => it.kind !== 'article');
    const idx = illusts.findIndex((it) => feedKey(it) === feedKey(item));
    if (idx < 0) return;
    const images: LbImageSource[] = illusts.map((it) => {
      const dims = it.width && it.height ? { width: it.width, height: it.height } : null;
      return {
        // Bake the share descriptors onto the image: work tags + author name
        // (author as lightweight attribution since feed items are others' works).
        tags: [...(it.tags || []), it.user_name].filter((t): t is string => !!t && !!t.trim()),
        uri: it.large_proxied || it.thumb_proxied,   // master1200 original (fallback thumb)
        dimensions: dims,
        thumbUri: it.thumb_proxied,
        thumbDimensions: dims,
        thumbRect: null,
        thumbRef: null,        // no thumb-hero from a recycled grid cell; clean fade open
        thumbBorderRadius: 12,
      };
    });
    analytics.capture('lightbox_open', { source: item.source, index: idx, total: images.length });
    openLightbox({
      images,
      index: idx,
      actions: standardImageActions(),
    });
  }, [openLightbox]);

  // Tap save → confirm dialog first (discloses 入库 + tags + desktop requirement).
  const requestSave = useCallback((item: FeedItem) => {
    const st = saveStateRef.current[item.illust_id];
    if (st === 'saving' || st === 'saved') return;
    if (!desktopOnlineRef.current) {
      Alert.alert('需要桌面端在线', '入库会把图存进桌面 Eagle 库，请先在同一账号打开桌面端。');
      return;
    }
    setConfirmItem(item);
  }, []);

  const saveTagLabel = useCallback((item: FeedItem): string => (
    item.source === 'ranking' ? 'Pixiv 排行'
      : item.source === 'pixivision' ? 'pixivision'
        : '订阅流'
  ), []);

  // Full tag set written on save: the artist's own work tags (ranking carries
  // them) first, then author name + a source label. Deduped. inbox/pixivision
  // illusts have no work tags upstream → just author + source.
  const saveTags = useCallback((item: FeedItem): string[] => {
    const out: string[] = [];
    const push = (t?: string) => { const v = (t || '').trim(); if (v && !out.includes(v)) out.push(v); };
    (item.tags || []).forEach(push);
    push(item.user_name);
    push(saveTagLabel(item));
    return out;
  }, [saveTagLabel]);

  // 入库 = reuse desktop import (download URL → lib.import_file w/ tags). Needs desktop online.
  const doSave = useCallback((item: FeedItem) => {
    if (!desktopOnlineRef.current) {
      Alert.alert('需要桌面端在线', '入库会把图存进桌面 Eagle 库，请先在同一账号打开桌面端。');
      return;
    }
    const url = item.large_proxied || item.thumb_proxied;
    if (!url || !item.illust_id) return;
    const tags = saveTags(item);
    const reqId = `feedsave_${Date.now()}_${item.illust_id}`;
    // Preserve the work's own title + source link, not just our tags — Eagle
    // would otherwise name the item after the URL filename.
    if (!remoteWS.importFiles([url], {
      tags, requestId: reqId,
      names: item.title ? [item.title] : [],
      sourceUrls: item.page_url ? [item.page_url] : [],
    })) {
      Alert.alert('发送失败', '桌面端连接断开，请重试。');
      return;
    }
    reqMap.current[reqId] = item.illust_id;
    setSaveState((s) => ({ ...s, [item.illust_id]: 'saving' }));
    analytics.capture('feed_item_saved', { source: item.source, platform: item.platform });
    showToast(`正在存入桌面库${tags[0] ? ` · #${tags[0]}` : ''}…`);
    // Watchdog: desktop never replies (offline mid-flight / lost event) → don't spin forever.
    setTimeout(() => {
      if (reqMap.current[reqId]) {
        delete reqMap.current[reqId];
        setSaveState((s) => (s[item.illust_id] === 'saving' ? { ...s, [item.illust_id]: 'failed' } : s));
      }
    }, 20000);
  }, [saveTags, showToast]);

  // ── Body ──
  let body: React.ReactNode;
  if (status === 'loading') {
    body = <CenterState><Spinner color={colors.brand.primary} /></CenterState>;
  } else if (status === 'disabled') {
    body = <CenterState><Text color={colors.text.tertiary} fontSize={14}>该功能暂未开启</Text></CenterState>;
  } else if (status === 'error') {
    body = (
      <CenterState>
        <Text color={colors.text.tertiary} fontSize={14}>加载失败</Text>
        <Pressable onPress={() => load(false)} hitSlop={8}>
          <Text color={colors.brand.primary} fontSize={14}>重试</Text>
        </Pressable>
      </CenterState>
    );
  } else if (items.length === 0) {
    body = tab === 'follow' ? (
      <CenterState>
        <YStack width={72} height={72} borderRadius={36} backgroundColor={colors.bg.surface}
          justifyContent="center" alignItems="center">
          <Rss size={32} color={colors.brand.accent} />
        </YStack>
        <Text color={colors.text.primary} fontSize={16} fontWeight="600">还没有新作</Text>
        <Text color={colors.text.tertiary} fontSize={13} textAlign="center">
          在桌面端订阅画师后{'\n'}他们的新作会出现在这里
        </Text>
        <Pressable onPress={() => setTab('discover')} hitSlop={8} style={{ marginTop: 4 }}>
          <XStack alignItems="center" gap={6} backgroundColor={colors.brand.soft}
            paddingHorizontal={16} paddingVertical={9} borderRadius={20}>
            <Sparkles size={16} color={colors.brand.primary} />
            <Text color={colors.text.primary} fontSize={14} fontWeight="600">去发现热门作品</Text>
          </XStack>
        </Pressable>
      </CenterState>
    ) : (
      <CenterState><Text color={colors.text.tertiary} fontSize={14}>这里暂时没有内容</Text></CenterState>
    );
  } else {
    body = (
      <FlashList
        // Remount on column change: FlashList's masonry engine keeps per-cell
        // arrangement state that a live numColumns flip corrupts (same as index.tsx).
        key={`cols-${cols}`}
        data={items}
        numColumns={cols}
        masonry
        optimizeItemArrangement
        keyExtractor={feedKey}
        getItemType={(it) => it.kind || 'illust'}   // keep article vs illust in separate recycle pools
        renderItem={({ item }) => (
          <FeedCell item={item} state={saveState[item.illust_id] ?? 'idle'} colW={colW}
            onSave={requestSave} onOpen={onOpen} />
        )}
        extraData={saveState}
        contentContainerStyle={{ paddingHorizontal: PAD, paddingTop: 4, paddingBottom: TAB_BAR_CLEARANCE }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand.primary} />
        }
        showsVerticalScrollIndicator={false}
      />
    );
  }

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg.canvas }}>
      {/* Segmented tabs + manage entry (manage shown only on 关注) */}
      <XStack marginHorizontal={16} marginTop={10} marginBottom={8} alignItems="center" gap={8}>
        <XStack flex={1} padding={3} borderRadius={11} backgroundColor={colors.bg.subtle}>
          <SegTab label="关注" active={tab === 'follow'} onPress={() => { setArticle(null); setTab('follow'); }} />
          <SegTab label="发现" active={tab === 'discover'} onPress={() => setTab('discover')} />
        </XStack>
        {tab === 'follow' && (
          <Pressable onPress={() => router.push('/subscriptions')} hitSlop={8}>
            <XStack width={42} height={42} borderRadius={12} alignItems="center" justifyContent="center"
              backgroundColor={colors.bg.subtle} borderWidth={1} borderColor={colors.border.default}>
              <UserCog size={20} color={colors.brand.primary} />
            </XStack>
          </Pressable>
        )}
      </XStack>

      {/* Discover sub-filters / article back row */}
      {tab === 'discover' && (
        article ? (
          <Pressable onPress={() => setArticle(null)} hitSlop={6}>
            <XStack marginHorizontal={16} marginBottom={8} alignItems="center" gap={4}>
              <ChevronLeft size={18} color={colors.brand.primary} />
              <Text color={colors.text.secondary} fontSize={14} fontWeight="600" numberOfLines={1} flex={1}>
                {article.title || '特辑'}
              </Text>
            </XStack>
          </Pressable>
        ) : (
          <XStack paddingHorizontal={16} marginBottom={8} gap={8}>
            {DISCOVER_FILTERS.map((f) => (
              <Chip key={f.key} label={f.label} active={discoverFilter === f.key}
                onPress={() => setDiscoverFilter(f.key)} />
            ))}
          </XStack>
        )
      )}

      {body}

      <AuraDialog
        visible={!!confirmItem}
        title="存入素材库"
        message={confirmItem
          ? `把这张图存入桌面的 Eagle 素材库\n标签：${saveTags(confirmItem).map((t) => '#' + t).join('  ')}`
          : ''}
        cancelLabel="取消"
        confirmLabel="存入"
        onClose={() => setConfirmItem(null)}
        onConfirm={() => { const it = confirmItem; setConfirmItem(null); if (it) doSave(it); }}
      />

      {toast && (
        <YStack position="absolute" bottom={TAB_BAR_CLEARANCE + 12} left={0} right={0}
          alignItems="center" pointerEvents="none">
          <XStack backgroundColor={colors.bg.surface} borderColor={colors.border.default} borderWidth={1}
            borderRadius={20} paddingHorizontal={16} paddingVertical={10} maxWidth="86%">
            <Text color={colors.text.primary} fontSize={13} numberOfLines={1}>{toast}</Text>
          </XStack>
        </YStack>
      )}
    </SafeAreaView>
  );
}
