import { getToken } from './auth';

// Feed data layer. Two surfaces share one normalized `FeedItem` shape:
//   关注 (follow)   → GET /v1/artist/inbox        — the user's subscription
//                     inbox (VPS cron poller + per-user fanout, already live).
//   发现 (discover) → GET /v1/feed/trending        — Pixiv ranking (daily/
//                     weekly/monthly) + pixivision spotlights. Stateless,
//                     read-only, free at cost; never touches the inbox/fanout.
// Subscribe/unsubscribe stays on desktop; mobile only reads + saves-to-library.

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
