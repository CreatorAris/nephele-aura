import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { ChevronLeft, Search, Check, X, UserPlus } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { colors } from '../theme/colors';
import { AuraInput } from '../components/AuraInput';
import {
  getSubscriptions, subscribeArtist, unsubscribeArtist, searchArtists,
  type SubscribedArtist, type ArtistSearchResult,
} from '../utils/subscriptions';
import analytics from '../utils/analytics';

// Subscription management — list / search / subscribe / unsubscribe. Mobile now
// owns this (was desktop-only); all four endpoints are the generic uid-authed
// ones desktop already used. New subscriptions also unlock push (see push.ts).
export default function SubscriptionsScreen() {
  const router = useRouter();
  const [subs, setSubs] = useState<SubscribedArtist[]>([]);
  const [cap, setCap] = useState(100);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ArtistSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  // pid set for O(1) "already subscribed" checks in search results.
  const subPids = new Set(subs.map((s) => s.pid));

  const loadSubs = useCallback(async () => {
    const data = await getSubscriptions();
    if (data) {
      setSubs(data.artists);
      setCap(data.cap);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void loadSubs(); }, [loadSubs]);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearched(true);
    const r = await searchArtists(q);
    setResults(r);
    setSearching(false);
    analytics.capture('aura_artist_search', { query_len: q.length, results: r.length });
  };

  const onSubscribe = async (a: ArtistSearchResult) => {
    if (subPids.has(a.pid)) return;
    // Optimistic add — revert on failure.
    setSubs((prev) => [...prev, { pid: a.pid, name: a.name }]);
    const res = await subscribeArtist(a.pid, a.name);
    if (!res.ok) {
      setSubs((prev) => prev.filter((s) => s.pid !== a.pid));
    } else {
      analytics.capture('aura_artist_subscribe', { pid: a.pid });
    }
  };

  const onUnsubscribe = async (pid: string) => {
    const removed = subs.find((s) => s.pid === pid);
    setSubs((cur) => cur.filter((s) => s.pid !== pid)); // optimistic
    const ok = await unsubscribeArtist(pid);
    if (!ok) {
      // Functional re-add (not a stale whole-array snapshot — a concurrent
      // unfollow taken after this snapshot would otherwise be clobbered).
      if (removed) setSubs((cur) => (cur.some((s) => s.pid === pid) ? cur : [...cur, removed]));
    } else {
      analytics.capture('aura_artist_unsubscribe', { pid });
    }
  };

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg.canvas }}>
      {/* Header */}
      <XStack alignItems="center" gap={6} paddingHorizontal={12} paddingVertical={10}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <ChevronLeft size={26} color={colors.text.primary} />
        </Pressable>
        <Text fontSize={18} fontWeight="700" color={colors.text.primary}>管理订阅</Text>
        <XStack flex={1} />
        <Text fontSize={13} color={colors.text.tertiary}>{subs.length} / {cap}</Text>
      </XStack>

      {/* Search */}
      <YStack paddingHorizontal={16} paddingBottom={10} gap={10}>
        <AuraInput
          icon={Search}
          value={query}
          onChangeText={setQuery}
          placeholder="搜索画师名（Pixiv）"
          autoCapitalize="none"
          onSubmitEditing={runSearch}
        />
        {searching && (
          <XStack paddingVertical={8} alignItems="center" gap={8}>
            <ActivityIndicator color={colors.brand.primary} />
            <Text fontSize={13} color={colors.text.tertiary}>搜索中…</Text>
          </XStack>
        )}
        {!searching && searched && results.length === 0 && (
          <Text fontSize={13} color={colors.text.tertiary} paddingVertical={6}>
            没找到匹配的画师，换个名字试试
          </Text>
        )}
        {!searching && results.map((a) => {
          const subscribed = subPids.has(a.pid);
          return (
            <XStack key={a.pid} alignItems="center" gap={10} paddingVertical={6}>
              <Image
                source={{ uri: a.avatar }}
                style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.bg.subtle }}
                transition={0}
              />
              <YStack flex={1}>
                <Text fontSize={15} fontWeight="600" color={colors.text.primary} numberOfLines={1}>
                  {a.name || a.pid}
                </Text>
                <Text fontSize={12} color={colors.text.tertiary}>
                  {a.sampleCount > 0 ? `${a.sampleCount} 件作品` : 'Pixiv'}
                </Text>
              </YStack>
              <Pressable onPress={() => onSubscribe(a)} disabled={subscribed} hitSlop={6}>
                <XStack height={34} paddingHorizontal={14} borderRadius={17} alignItems="center" gap={5}
                  backgroundColor={subscribed ? colors.bg.subtle : colors.brand.primary}>
                  {subscribed
                    ? <Check size={15} color={colors.text.tertiary} />
                    : <UserPlus size={15} color={colors.bg.canvas} />}
                  <Text fontSize={13} fontWeight="600"
                    color={subscribed ? colors.text.tertiary : colors.bg.canvas}>
                    {subscribed ? '已关注' : '关注'}
                  </Text>
                </XStack>
              </Pressable>
            </XStack>
          );
        })}
      </YStack>

      {/* My subscriptions */}
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
        <Text fontSize={13} fontWeight="600" color={colors.text.secondary} marginTop={4} marginBottom={8}>
          我的关注
        </Text>
        {loading ? (
          <XStack paddingVertical={20} justifyContent="center">
            <ActivityIndicator color={colors.brand.primary} />
          </XStack>
        ) : subs.length === 0 ? (
          <Text fontSize={14} color={colors.text.tertiary} paddingVertical={16}>
            还没关注任何画师。在上方搜索画师名添加，关注的画师发布新作时会推送通知你。
          </Text>
        ) : (
          subs.map((s) => (
            <XStack key={s.pid} alignItems="center" gap={10} paddingVertical={10}
              borderBottomWidth={1} borderColor={colors.border.default}>
              <YStack flex={1}>
                <Text fontSize={15} color={colors.text.primary} numberOfLines={1}>
                  {s.name || `Pixiv ${s.pid}`}
                </Text>
                <Text fontSize={12} color={colors.text.tertiary}>pid {s.pid}</Text>
              </YStack>
              <Pressable onPress={() => onUnsubscribe(s.pid)} hitSlop={6}>
                <XStack height={32} paddingHorizontal={12} borderRadius={16} alignItems="center" gap={4}
                  borderWidth={1} borderColor={colors.border.default}>
                  <X size={14} color={colors.text.tertiary} />
                  <Text fontSize={13} color={colors.text.secondary}>取关</Text>
                </XStack>
              </Pressable>
            </XStack>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
