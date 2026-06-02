import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { AppState, type AppStateStatus, Platform } from 'react-native';

/**
 * Aura telemetry client.
 *
 * Routes events through the nephele-api Worker relay (POST /v1/telemetry/batch)
 * rather than the PostHog SDK on purpose:
 *   - The PostHog project key stays server-side (env.POSTHOG_PROJECT_KEY), so it
 *     never ships in this open-source (MIT) bundle.
 *   - The relay already enforces a per-IP rate limit and stamps server ground
 *     truth ($ip / cf_country / server_ts / x_client_type), so fork/spoof
 *     traffic is bounded and filterable.
 * X-Client-Type distinguishes Aura from the desktop app (and the legacy
 * nephele-mobile-v1 web bridge) in PostHog via the `x_client_type` property.
 *
 * distinct_id mirrors the desktop's unified identity: after login it is the
 * server uid, so PostHog stitches desktop + mobile into a single person. Before
 * login a persisted anonymous id is used, and identify() merges it into the uid.
 */

const API_BASE = 'https://api.arisfusion.com';
const RELAY_ENDPOINT = `${API_BASE}/v1/telemetry/batch`;
const CLIENT_TYPE = 'nephele-aura';

const ANON_ID_KEY = 'nephele_anon_id';
const QUEUE_KEY = 'nephele_telemetry_queue';
const OPT_OUT_KEY = 'nephele_analytics_opt_out';

// Worker rejects batches > 50 events. Flush on a timer, on backgrounding, and
// whenever the queue fills, whichever comes first.
const MAX_BATCH = 50;
const FLUSH_INTERVAL_MS = 15_000;
// Hard cap so a long offline stretch can't grow the persisted queue unbounded;
// oldest events are dropped first.
const MAX_QUEUE = 200;

const APP_VERSION = (Constants.expoConfig?.version as string | undefined) ?? 'unknown';

type EventProps = Record<string, unknown>;

interface QueuedEvent {
  name: string;
  props: EventProps;
  ts: number; // seconds; relay uses this for client/server skew analysis
  distinct_id: string;
}

let queue: QueuedEvent[] = [];
let currentDistinctId: string | null = null;
// First-run fallback id. Only becomes a real identity if no persisted id exists
// (init() persists it then). It is NEVER used to stamp events before init()
// resolves — those are buffered in `pendingEvents` and stamped afterwards (see
// below). Stamping early events with this ephemeral seed used to mint a fresh
// orphan PostHog person on every cold start.
let anonId: string = uuid();
let optedOut = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;
let initialized = false;
// Identity (persisted anon id / uid) is resolved asynchronously by init(). Until
// then, events captured during the cold-start window are held here WITHOUT a
// distinct_id and stamped with the resolved id once init() finishes, so the
// initial $screen no longer fragments one install into many PostHog persons.
let identityResolved = false;
let pendingEvents: { name: string; props: EventProps; ts: number }[] = [];

/** RFC4122-ish v4 id. Not security-sensitive — just a stable anonymous handle. */
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function commonProps(): EventProps {
  return {
    platform: 'mobile',
    os: Platform.OS,
    app_version: APP_VERSION,
  };
}

async function persistQueue(): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Best-effort: a failed persist just means we risk losing buffered events
    // on a hard kill. Never let it break the calling path.
  }
}

/**
 * Initialize once at app start. Restores any persisted anon id + queued events,
 * starts the flush timer, and tracks app lifecycle transitions.
 */
export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    const [optOutRaw, storedAnon, storedQueue] = await AsyncStorage.multiGet([
      OPT_OUT_KEY,
      ANON_ID_KEY,
      QUEUE_KEY,
    ]);
    optedOut = optOutRaw[1] === 'true';

    if (storedAnon[1]) {
      anonId = storedAnon[1];               // adopt the cross-launch stable id
    } else {
      await AsyncStorage.setItem(ANON_ID_KEY, anonId);  // first run — persist the seeded one
    }
    if (!currentDistinctId) currentDistinctId = anonId;

    if (storedQueue[1]) {
      try {
        const parsed = JSON.parse(storedQueue[1]) as QueuedEvent[];
        if (Array.isArray(parsed)) queue = parsed.slice(-MAX_QUEUE);
      } catch {
        // Corrupt queue — drop it.
      }
    }
  } catch {
    // Storage unavailable — fall back to the module-seeded anonId (already set).
    if (!currentDistinctId) currentDistinctId = anonId;
  }

  // Identity is now resolved (stored id / freshly persisted / fallback seed).
  // Drain events captured during the async window above, stamped with the
  // resolved id so a cold start doesn't orphan them under an ephemeral id.
  identityResolved = true;
  if (pendingEvents.length) {
    const did = currentDistinctId ?? anonId;
    for (const e of pendingEvents) {
      queue.push({ name: e.name, props: e.props, ts: e.ts, distinct_id: did });
    }
    pendingEvents = [];
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    void persistQueue();
  }

  flushTimer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);

  appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') {
      capture('app_opened');
    } else if (state === 'background' || state === 'inactive') {
      capture('app_backgrounded');
      void flush(); // best chance to drain before the OS suspends us
    }
  });

  capture('app_opened');
  void flush();
}

/**
 * Associate subsequent events with the server uid and merge the prior anonymous
 * identity into it (PostHog $anon_distinct_id merge). Call right after login.
 */
export function identify(uid: string, props: EventProps = {}): void {
  if (!uid) return;
  if (optedOut) return;   // opted out → no identity linkage at all
  const previous = currentDistinctId;
  currentDistinctId = uid;

  // $identify with $anon_distinct_id tells PostHog to fold the anonymous
  // person into the uid person, so pre-login events aren't orphaned.
  enqueue('$identify', {
    $set: { ...commonProps(), ...props },
    ...(previous && previous !== uid ? { $anon_distinct_id: previous } : {}),
  }, uid);
  void flush();
}

/** Drop the uid association on logout and fall back to the anonymous id. */
export function reset(): void {
  currentDistinctId = anonId;
}

export function capture(name: string, props: EventProps = {}): void {
  if (optedOut) return;
  const merged = { ...commonProps(), ...props };
  if (!identityResolved) {
    // Buffer until init() resolves the persisted identity; ts captured now so
    // the eventual event keeps its real timestamp.
    pendingEvents.push({ name, props: merged, ts: Date.now() / 1000 });
    if (pendingEvents.length > MAX_QUEUE) pendingEvents = pendingEvents.slice(-MAX_QUEUE);
    return;
  }
  enqueue(name, merged, currentDistinctId ?? anonId);
}

/** PostHog mobile screen event. Pass the route path (e.g. expo-router pathname). */
export function screen(name: string, props: EventProps = {}): void {
  capture('$screen', { $screen_name: name, ...props });
}

export async function setOptOut(value: boolean): Promise<void> {
  optedOut = value;
  try {
    await AsyncStorage.setItem(OPT_OUT_KEY, value ? 'true' : 'false');
  } catch {
    // ignore
  }
  if (value) {
    queue = [];
    void persistQueue();
  }
}

export function isOptedOut(): boolean {
  return optedOut;
}

function enqueue(name: string, props: EventProps, distinctId: string): void {
  queue.push({ name, props, ts: Date.now() / 1000, distinct_id: distinctId });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  void persistQueue();
  if (queue.length >= MAX_BATCH) void flush();
}

let flushing = false;

/** Drain up to one batch to the relay. Fire-and-forget; failures stay queued. */
export async function flush(): Promise<void> {
  if (flushing || queue.length === 0 || optedOut) return;
  flushing = true;

  const batch = queue.slice(0, MAX_BATCH);
  try {
    const res = await fetch(RELAY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Type': CLIENT_TYPE,
      },
      body: JSON.stringify({ events: batch }),
    });
    if (res.ok || res.status === 202) {
      // Accepted — drop exactly what we sent (the queue may have grown meanwhile).
      queue = queue.slice(batch.length);
      await persistQueue();
    }
    // Non-2xx (incl. 429 rate-limited): leave the batch queued, retry next cycle.
  } catch {
    // Offline / network error: keep the batch for the next flush.
  } finally {
    flushing = false;
  }
}

/** Tear down timers/listeners. Mainly for tests; the app runs init() for its lifetime. */
export function shutdown(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (appStateSub) { appStateSub.remove(); appStateSub = null; }
  initialized = false;
  identityResolved = false;   // so a subsequent init() re-runs the pending drain
  pendingEvents = [];
}

export const analytics = {
  init,
  identify,
  reset,
  capture,
  screen,
  flush,
  setOptOut,
  isOptedOut,
  shutdown,
};

export default analytics;
