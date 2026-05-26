import { getToken } from './auth';

// Feed data layer. Two surfaces share one normalized `FeedItem` shape:
//   关注 (follow)   → GET /v1/artist/inbox        — the user's subscription
//                     inbox (VPS cron poller + per-user fanout, already live).
//   发现 (discover) → GET /v1/feed/trending        — Pixiv ranking (daily/
//                     weekly/monthly) + pixivision spotlights. Stateless,
//                     read-only, free at cost; never touches the inbox/fanout.
// Subscription management (list/search/subscribe/unsubscribe) now lives on
// mobile too (2026-05-27) — the backend endpoints were always generic; the
// "desktop-only management" was a client choice, reversed for Aura.

const API_BASE = 'https://api.arisfusion.com';
const CLIENT_TYPE = 'nephele-mobile-v1';   // matches the rest of auth.ts API calls

export type FeedSource = 'subscription' | 'ranking' | 'pixivision';
export type TrendingMode = 'daily' | 'weekly' | 'monthly';

export interface FeedItem {
  source: FeedSource;
  kind?: 'article' | 'illust';   // pixivision spotlight cards are 'article'

  // identity
  illust_id: string;             // pixiv artwork id (empty for article cards)
  article_id?: string;           // pixivision article id
  pid?: string;                  // artist id

  // display
  platform: string;
  title: string;
  user_name: string;
  thumb_proxied: string;         // square/crop thumb, via /v1/pixiv/img
  large_proxied?: string;        // master1200, via /v1/pixiv/img (when derivable)
  page_url: string;
  ts: number;                    // unix seconds

  // intrinsic dims → aspect-ratio masonry without an onLoad measure pass.
  // 0 when unknown (inbox/pixivision) → caller falls back to a square cell.
  width: number;
  height: number;

  // ranking-only
  rank?: number;
  bookmark_count?: number;

  // subscription-only
  backfill?: boolean;            // snapshot taken at subscribe time, not a new post

  // pixivision article card
  tags?: string[];
  article_url?: string;
}

// Back-compat alias (older imports referenced InboxItem).
export type InboxItem = FeedItem;

export interface FeedResult {
  success: boolean;
  items: FeedItem[];
  featureDisabled: boolean;      // backend kill-switch off → render "feature off", not an error
}

// i.pximg.net blocks hotlinking (Referer check); only our Worker can sign it.
// Route every pximg URL through the /v1/pixiv/img bytes proxy. Mirrors the
// desktop's tools_bridge._wrap / _derive_large so mobile shows the same images.
function wrapPximg(u: string): string {
  if (!u || !u.includes('pximg.net')) return u;
  return `${API_BASE}/v1/pixiv/img?url=${encodeURIComponent(u)}`;
}

// Ranking/pixivision thumbs are bounding-box crops like /c/240x480/ or
// /c/250x250_80_a2/ in front of img-master; strip the crop segment to reach
// the master1200 source. Mirrors tools_bridge._derive_large (regex form).
function deriveLarge(thumb: string): string {
  if (!thumb || !thumb.includes('pximg.net')) return '';
  const rewritten = thumb
    .replace(/\/c\/\d+x\d+(_\d+(_[a-z0-9]+)?)?\//, '/')
    .replace('/custom-thumb/', '/img-master/')
    .replace('_square1200', '_master1200')
    .replace('_custom1200', '_master1200');
  return rewritten !== thumb ? rewritten : '';
}

// Add thumb_proxied / large_proxied from a raw i.pximg thumb URL.
function proxyThumb(raw: string): { thumb_proxied: string; large_proxied?: string } {
  const large = deriveLarge(raw);
  return {
    thumb_proxied: wrapPximg(raw),
    large_proxied: large ? wrapPximg(large) : undefined,
  };
}

async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await getToken();
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, 'X-Client-Type': CLIENT_TYPE };
}

/**
 * Fetch the user's subscription inbox (newest first). Pass clear=true to mark
 * it read server-side; mobile defaults to clear=false so refreshing keeps the
 * full list (desktop owns the read/clear semantics).
 */
export async function fetchInbox(clear = false): Promise<FeedResult> {
  const headers = await authHeaders();
  if (!headers) return { success: false, items: [], featureDisabled: false };
  try {
    const res = await fetch(`${API_BASE}/v1/artist/inbox${clear ? '?clear=true' : ''}`, { headers });
    if (!res.ok) return { success: false, items: [], featureDisabled: false };
    const data = await res.json();
    const raw: unknown[] = Array.isArray(data.items) ? data.items : [];

    const items: FeedItem[] = raw.map((r) => {
      const it = r as Record<string, unknown>;
      const thumb = String(it.thumb_url || '');
      const illustId = String(it.illust_id || '');
      return {
        source: 'subscription',
        platform: String(it.platform || 'pixiv'),
        illust_id: illustId,
        pid: String(it.pid || ''),
        title: String(it.title || ''),
        ...proxyThumb(thumb),
        page_url: String(it.page_url || (illustId ? `https://www.pixiv.net/artworks/${illustId}` : '')),
        user_name: String(it.user_name || ''),
        ts: Number(it.ts || 0),
        width: 0,        // inbox snapshots don't carry dims → square cell
        height: 0,
        backfill: !!it.backfill,
      };
    });

    items.sort((a, b) => b.ts - a.ts);   // newest first regardless of KV order
    return { success: true, items, featureDisabled: !!data.feature_disabled };
  } catch {
    return { success: false, items: [], featureDisabled: false };
  }
}

/**
 * 发现 feed. kind='ranking' (mode=daily|weekly|monthly) returns illust cells;
 * kind='pixivision' returns spotlight article cards. Read-only, free.
 */
export async function fetchTrending(
  kind: 'ranking' | 'pixivision',
  mode: TrendingMode = 'daily',
): Promise<FeedResult> {
  const headers = await authHeaders();
  if (!headers) return { success: false, items: [], featureDisabled: false };
  try {
    const qs = kind === 'ranking' ? `?kind=ranking&mode=${mode}` : '?kind=pixivision';
    const res = await fetch(`${API_BASE}/v1/feed/trending${qs}`, { headers });
    if (res.status === 403) return { success: false, items: [], featureDisabled: true };
    if (!res.ok) return { success: false, items: [], featureDisabled: false };
    const data = await res.json();
    if (data.feature_disabled) return { success: true, items: [], featureDisabled: true };
    const raw: unknown[] = Array.isArray(data.items) ? data.items : [];

    const items: FeedItem[] = raw.map((r) => {
      const it = r as Record<string, unknown>;
      if (kind === 'pixivision') {
        return {
          source: 'pixivision',
          kind: 'article',
          illust_id: '',
          article_id: String(it.article_id || ''),
          platform: 'pixiv',
          title: String(it.title || ''),
          user_name: '',
          ...proxyThumb(String(it.thumb_url || '')),
          page_url: String(it.article_url || ''),
          article_url: String(it.article_url || ''),
          ts: 0,
          width: 0,
          height: 0,
          tags: Array.isArray(it.tags) ? (it.tags as string[]).slice(0, 6) : [],
        };
      }
      const illustId = String(it.illust_id || '');
      return {
        source: 'ranking',
        kind: 'illust',
        illust_id: illustId,
        pid: String(it.user_id || ''),
        platform: 'pixiv',
        title: String(it.title || ''),
        user_name: String(it.user_name || ''),
        ...proxyThumb(String(it.thumb_url || '')),
        page_url: String(it.page_url || (illustId ? `https://www.pixiv.net/artworks/${illustId}` : '')),
        ts: Number(it.ts || 0),
        width: Number(it.width || 0),
        height: Number(it.height || 0),
        rank: Number(it.rank || 0),
        bookmark_count: Number(it.bookmark_count || 0),
        tags: Array.isArray(it.tags) ? (it.tags as string[]).slice(0, 15) : [],   // artist's own work tags
      };
    });

    return { success: true, items, featureDisabled: false };
  } catch {
    return { success: false, items: [], featureDisabled: false };
  }
}

/** Drill into one pixivision spotlight — its curated illusts as feed cells. */
export async function fetchPixivisionArticle(articleId: string): Promise<FeedResult> {
  const headers = await authHeaders();
  if (!headers || !/^\d+$/.test(articleId)) {
    return { success: false, items: [], featureDisabled: false };
  }
  try {
    const res = await fetch(`${API_BASE}/v1/feed/pixivision-article?id=${articleId}`, { headers });
    if (!res.ok) return { success: false, items: [], featureDisabled: false };
    const data = await res.json();
    if (!data.success) return { success: false, items: [], featureDisabled: false };
    const raw: unknown[] = Array.isArray(data.items) ? data.items : [];

    const items: FeedItem[] = raw.map((r) => {
      const it = r as Record<string, unknown>;
      const illustId = String(it.illust_id || '');
      return {
        source: 'pixivision',
        kind: 'illust',
        illust_id: illustId,
        article_id: articleId,
        pid: String(it.user_id || ''),
        platform: 'pixiv',
        title: String(it.title || ''),
        user_name: String(it.user_name || ''),
        ...proxyThumb(String(it.thumb_url || '')),
        page_url: String(it.page_url || (illustId ? `https://www.pixiv.net/artworks/${illustId}` : '')),
        ts: 0,
        width: 0,
        height: 0,
      };
    });

    return { success: true, items, featureDisabled: false };
  } catch {
    return { success: false, items: [], featureDisabled: false };
  }
}

// ---------------------------------------------------------------------------
// Subscription management (管理：列表 / 搜索 / 关注 / 取关)
// Same backend endpoints desktop uses — generic, authed by uid.
// ---------------------------------------------------------------------------

export interface SubscribedArtist {
  pid: string;
  name: string;
}

export interface ArtistSearchResult {
  pid: string;
  name: string;
  avatar: string; // proxied
  sampleThumbs: string[]; // proxied sample illust thumbs (≤3)
  sampleCount: number;
}

/** GET the user's subscribed artists. */
export async function getSubscriptions(): Promise<{ artists: SubscribedArtist[]; cap: number } | null> {
  const headers = await authHeaders();
  if (!headers) return null;
  try {
    const res = await fetch(`${API_BASE}/v1/artist/subscriptions`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success) return null;
    const artists: SubscribedArtist[] = (Array.isArray(data.artists) ? data.artists : [])
      .map((a: Record<string, unknown>) => ({ pid: String(a.pid || ''), name: String(a.name || '') }))
      .filter((a: SubscribedArtist) => a.pid);
    return { artists, cap: Number(data.cap || 100) };
  } catch {
    return null;
  }
}

/** Subscribe to a pixiv artist (idempotent server-side). */
export async function subscribeArtist(pid: string, name = ''): Promise<{ ok: boolean; error?: string }> {
  const headers = await authHeaders();
  if (!headers) return { ok: false, error: '未登录' };
  try {
    const res = await fetch(`${API_BASE}/v1/artist/subscribe`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'pixiv', user_id: pid, user_name: name }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) return { ok: true };
    return { ok: false, error: data.error || `失败 (${res.status})` };
  } catch {
    return { ok: false, error: '网络错误' };
  }
}

/** Unsubscribe from a pixiv artist. */
export async function unsubscribeArtist(pid: string): Promise<boolean> {
  const headers = await authHeaders();
  if (!headers) return false;
  try {
    const res = await fetch(`${API_BASE}/v1/artist/subscribe`, {
      method: 'DELETE',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'pixiv', user_id: pid }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && !!data.success;
  } catch {
    return false;
  }
}

/**
 * Search pixiv artists by display name. Rerank exact-name matches first, then
 * artists that actually have sample works — pixiv's default order surfaces
 * follower/registration-sorted accounts, not necessarily the real artist.
 */
export async function searchArtists(nick: string): Promise<ArtistSearchResult[]> {
  const headers = await authHeaders();
  if (!headers || !nick.trim()) return [];
  try {
    const res = await fetch(
      `${API_BASE}/v1/pixiv/user/search?nick=${encodeURIComponent(nick.trim())}`,
      { headers },
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.success) return [];
    const users: ArtistSearchResult[] = (Array.isArray(data.users) ? data.users : [])
      .map((u: Record<string, any>) => {
        const samples = Array.isArray(u.sample_illusts) ? u.sample_illusts : [];
        const thumbs = samples
          .map((s: Record<string, unknown>) => String(s.url || ''))
          .filter(Boolean)
          .slice(0, 3);
        return {
          pid: String(u.user_id || u.pid || u.id || ''),
          name: String(u.user_name || u.name || u.nick || ''),
          // user_avatar is proxied server-side (the raw field is `profile_img`,
          // now normalized in the Worker). Raw URLs can't be used directly
          // (pximg Referer block), so fall back to the first proxied sample
          // thumb — never the raw avatar — so the row never shows an empty circle.
          avatar: String(u.user_avatar || '') || thumbs[0] || '',
          sampleThumbs: thumbs,
          sampleCount: samples.length,
        };
      })
      .filter((u: ArtistSearchResult) => u.pid);

    const q = nick.trim().toLowerCase();
    return users.sort((a, b) => {
      const ax = a.name.toLowerCase() === q ? 1 : 0;
      const bx = b.name.toLowerCase() === q ? 1 : 0;
      if (ax !== bx) return bx - ax; // exact name match first
      return b.sampleCount - a.sampleCount; // then artists who actually have works
    });
  } catch {
    return [];
  }
}
