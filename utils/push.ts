// Push notifications via JPush (aggregator that fans out to 华为/小米/OPPO/vivo
// system channels — works on GMS-less domestic Android). The native SDK is wired
// by plugins/withJPush; until a build includes it, requiring the module fails and
// every call here no-ops (dormant). Init is deliberately deferred to after login
// + consent, not app launch, so the SDK doesn't collect on cold start.
import { Platform, AppState, DeviceEventEmitter } from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getToken } from './auth';
import analytics from './analytics';

// Emitted when the server fires a silent OTA-trigger push (extras.type === 'ota').
// UpdateGate listens and pulls the bundle immediately — push-driven, no polling.
export const OTA_TRIGGER_EVENT = 'aura-ota-trigger';

const API_BASE = 'https://api.arisfusion.com';
const CLIENT_TYPE = 'nephele-mobile-v1'; // matches the authed API calls in auth.ts/subscriptions.ts

// Subscription-push consent (Huawei "服务与通讯类-订阅类" compliance): push is
// NOT enabled at login. It is gated behind an explicit, declinable dialog shown
// after the user subscribes (see subscriptions screen), and can be turned off
// any time in 我的 → 更新推送. Consent has two effects:
//   • client: only after granting do we initPush() (OS permission + token reg);
//   • server: a `push_consent:<uid>` flag the fanout checks before sending, so
//     toggling OFF stops delivery even though the device token stays registered.
const CONSENT_KEY = 'push_consent'; // 'granted' | 'denied' | unset

let initialized = false;
let appStateSub: { remove: () => void } | null = null;
let otaListenerAdded = false;

/** Read the stored subscription-push consent. null = never asked yet. */
export async function getPushConsent(): Promise<'granted' | 'denied' | null> {
  try {
    const v = await AsyncStorage.getItem(CONSENT_KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null;
  }
}

/** Mirror the consent flag to the server so fanout can honor it. No-op when
 *  logged out (consent is only ever set in an authed context). Best-effort. */
async function syncConsentToServer(granted: boolean): Promise<void> {
  try {
    const token = await getToken();
    if (!token) return;
    await fetch(`${API_BASE}/v1/aura/push/consent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Client-Type': CLIENT_TYPE,
      },
      body: JSON.stringify({ consent: granted }),
    });
  } catch (e) {
    console.warn('[push] consent sync failed', e);
  }
}

/**
 * Record the user's subscription-push consent. On grant: flip the server flag
 * and enable push for real (initPush → OS permission prompt + token reg). On
 * decline: flip the server flag off (fanout then skips this user) and register
 * nothing. Safe to call repeatedly and when push is unconfigured.
 */
export async function setPushConsent(
  granted: boolean,
  opts?: { requestPermission?: boolean },
): Promise<void> {
  try { await AsyncStorage.setItem(CONSENT_KEY, granted ? 'granted' : 'denied'); } catch { /* non-fatal */ }
  analytics.capture('push_consent_set', { granted });
  await syncConsentToServer(granted);
  // The OS notification permission is requested ONLY at first use (first artist
  // subscription), never from the settings toggle or app launch — the caller
  // signals that moment via opts.requestPermission. initPush itself just wires
  // up JPush + token registration.
  if (granted) await initPush({ requestPermission: opts?.requestPermission });
}

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
export async function initPush(opts?: { requestPermission?: boolean }): Promise<void> {
  const JPush = getJPush();
  if (!JPush) return; // native module absent → dormant

  // OS notification permission is requested ONLY when the caller is at the
  // first-use moment (opts.requestPermission). This sits ABOVE the `initialized`
  // guard so a later first-use can still prompt even if JPush was already wired
  // up token-side on a prior launch. Android/iOS suppress the dialog once the
  // user has decided, so calling it again is a no-op, not a re-prompt.
  if (opts?.requestPermission) {
    try {
      const perm = await Notifications.requestPermissionsAsync();
      analytics.capture('push_permission', { granted: perm.status === 'granted' });
    } catch { /* non-fatal */ }
  }

  if (initialized) return;
  try {
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

    // Silent OTA-trigger: the server fires a custom (透传) message after
    // publishing a bundle; surface it as an app event so UpdateGate pulls the
    // update at once (push-driven, no polling). Guarded against re-init stacking.
    if (!otaListenerAdded && typeof JPush.addCustomMessageListener === 'function') {
      JPush.addCustomMessageListener((msg: any) => {
        let extras = msg?.extras;
        if (typeof extras === 'string') { try { extras = JSON.parse(extras); } catch { extras = {}; } }
        if (extras?.type === 'ota') DeviceEventEmitter.emit(OTA_TRIGGER_EVENT);
      });
      otaListenerAdded = true;
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
    const res = await fetch(`${API_BASE}/v1/aura/push/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Client-Type': CLIENT_TYPE,
      },
      body: JSON.stringify({ registration_id: registrationId, platform: Platform.OS }),
    });
    if (res.ok) analytics.capture('push_registered', { platform: Platform.OS });
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
