// Push notifications via JPush (aggregator that fans out to 华为/小米/OPPO/vivo
// system channels — works on GMS-less domestic Android). The native SDK is wired
// by plugins/withJPush; until a build includes it, requiring the module fails and
// every call here no-ops (dormant). Init is deliberately deferred to after login
// + consent, not app launch, so the SDK doesn't collect on cold start.
import { Platform, AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { getToken } from './auth';

const API_BASE = 'https://api.arisfusion.com';
const CLIENT_TYPE = 'nephele-mobile-v1'; // matches the authed API calls in auth.ts/subscriptions.ts

let initialized = false;
let appStateSub: { remove: () => void } | null = null;

// Resolve the native module lazily. Absent (not yet built with the plugin) →
// null → all push calls become no-ops.
function getJPush(): any | null {
  try {
    // Variable module name so TS/bundler don't statically resolve it — the
    // package may be uninstalled (JPush native is wired in a dedicated build
    // step). Absent → null → dormant.
    const moduleName = 'jpush-react-native';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(moduleName);
    return mod?.default ?? mod ?? null;
  } catch {
    return null;
  }
}

/** Reset the app icon badge to 0 (JPush-managed; clears the launcher red dot). */
export function clearBadge(): void {
  const JPush = getJPush();
  try {
    JPush?.setBadge?.({ badge: 0, appBadge: 0 });
  } catch {
    /* non-fatal */
  }
}

/**
 * Initialize JPush and register this device's RegistrationID with the backend.
 * Safe to call repeatedly and when unconfigured (no-ops). Call after the user is
 * logged in; if not logged in yet, registration is skipped and should be retried
 * post-login via registerPushToken().
 */
export async function initPush(): Promise<void> {
  if (initialized) return;
  const JPush = getJPush();
  if (!JPush) return; // native module absent → dormant
  try {
    // Ask for notification permission (Android 13+, and Huawei EMUI prompts on
    // 12 too). Without this, the OS silently drops every notification even
    // though JPush delivered it. Don't block on the result — registration can
    // proceed regardless; the user can still grant later in settings.
    try { await Notifications.requestPermissionsAsync(); } catch { /* non-fatal */ }

    JPush.init?.();
    JPush.setLoggerEnable?.(false);
    initialized = true;

    // Clear the launcher icon badge now and every time the app foregrounds —
    // pushes increment it (JPush-managed; Huawei badge works because the entry
    // Activity is set in the JPush console). Opening the app = "seen" → reset 0.
    clearBadge();
    // Add the foreground listener once — addEventListener returns a subscription
    // that must not be dropped (it'd stack on dev fast-refresh / repeat init).
    if (!appStateSub) {
      appStateSub = AppState.addEventListener('change', (s) => { if (s === 'active') clearBadge(); });
    }

    const registrationId = await getRegistrationId(JPush);
    if (registrationId) await registerPushToken(registrationId);
  } catch (e) {
    console.warn('[push] init failed', e);
  }
}

function getRegistrationId(JPush: any): Promise<string | undefined> {
  // First-time registration with the JPush server can take 10-30s; a single
  // 5s wait misses it. Poll getRegistrationID every 2s up to ~24s until the
  // RegistrationID is non-empty.
  return new Promise((resolve) => {
    if (typeof JPush.getRegistrationID !== 'function') {
      console.warn('[push] getRegistrationID unavailable (SDK version mismatch?)');
      resolve(undefined);
      return;
    }
    let attempts = 0;
    const tryOnce = () => {
      try {
        JPush.getRegistrationID((res: any) => {
          const rid = res?.registerID || res?.registrationID;
          if (rid) { resolve(rid); return; }
          if (++attempts >= 12) { resolve(undefined); return; }
          setTimeout(tryOnce, 2000);
        });
      } catch {
        resolve(undefined);
      }
    };
    tryOnce();
  });
}

/** POST the device token to the backend. No-op when not logged in. */
export async function registerPushToken(registrationId: string): Promise<void> {
  try {
    const token = await getToken();
    if (!token) return; // not logged in — caller retries after login
    await fetch(`${API_BASE}/v1/aura/push/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Client-Type': CLIENT_TYPE,
      },
      body: JSON.stringify({ registration_id: registrationId, platform: Platform.OS }),
    });
  } catch (e) {
    console.warn('[push] register failed', e);
  }
}

/**
 * Re-fetch the RegistrationID and register it. Call right after a successful
 * login so a device that initialized JPush while logged out gets its token
 * attached to the now-authenticated uid.
 */
export async function syncPushTokenAfterLogin(): Promise<void> {
  const JPush = getJPush();
  if (!JPush || !initialized) return;
  const registrationId = await getRegistrationId(JPush);
  if (registrationId) await registerPushToken(registrationId);
}
