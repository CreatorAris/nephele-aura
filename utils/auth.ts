import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import analytics from './analytics';

const API_BASE = 'https://api.arisfusion.com';
const CLIENT_TYPE = 'nephele-mobile-v1';

const STORAGE_KEYS = {
  accessToken: 'nephele_access_token',
  refreshToken: 'nephele_refresh_token',
  userInfo: 'nephele_user_info',
  deviceFp: 'nephele_device_fp',
} as const;

/**
 * Stable per-install device fingerprint for the pairing registry (desktop
 * session manager). Purely an identity handle — NOT the paid-device binding
 * fp (we still never send X-Device-Fp, see getLicenseStatus). Persisted so
 * re-pairing updates the same registry entry instead of appending a new one.
 */
async function getDeviceFp(): Promise<string> {
  try {
    const existing = await AsyncStorage.getItem(STORAGE_KEYS.deviceFp);
    if (existing) return existing;
    // Not a security credential, just a registry handle — Math.random is
    // fine and avoids a crypto polyfill (Hermes has no Web Crypto).
    let fp = Date.now().toString(16);
    while (fp.length < 16) fp += Math.floor(Math.random() * 16).toString(16);
    fp = fp.slice(0, 16);
    await AsyncStorage.setItem(STORAGE_KEYS.deviceFp, fp);
    return fp;
  } catch {
    return '';
  }
}

/** Human-readable device name for the desktop session manager. */
function getDeviceName(): string {
  try {
    return (Device.modelName || Device.deviceName || '').slice(0, 48);
  } catch {
    return '';
  }
}

export type UserInfo = {
  uid: string;
  email: string;
  nickname: string;
  avatar?: string;
};

// Backend uses legacy `credits` naming for what the user-facing copy calls
// 云晶 (Nepheline). Field names are preserved as-is to match Worker code;
// translation to "云晶" happens in the UI layer.
export type LicenseStatus = {
  valid: boolean;
  tier: string;                    // "free" | "alpha" | "event" | paid tier name
  status?: string;                 // "active" | "expired" | ...
  expires_at?: string;             // ISO datetime
  credits_remaining?: number;      // annual Nepheline pool remaining
  credits_limit?: number;          // annual Nepheline pool total (typically 50000)
  purchased_credits?: number;      // purchased Nepheline balance (never expires)
  total_remaining?: number;        // credits_remaining + purchased_credits
  event_name?: string;             // populated when tier === "event"
  event_expires?: string;
};

type Result = {
  success: boolean;
  message: string;
};

type LoginResult = Result & {
  user?: UserInfo;
};

/**
 * Step 1: Send verification code to email
 * Note: CAPTCHA is required on web but mobile may be exempt
 * depending on server-side config. We send without CAPTCHA first.
 */
export async function sendCode(email: string): Promise<Result & { retryAfter?: number }> {
  try {
    const res = await fetch(`${API_BASE}/auth/send-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Type': CLIENT_TYPE,
      },
      body: JSON.stringify({ email }),
    });

    const data = await res.json();
    console.log('[AUTH] send-code response:', res.status, JSON.stringify(data));

    if (res.status === 429) {
      return {
        success: false,
        message: `请${data.retry_after || 60}秒后再试`,
        retryAfter: data.retry_after || 60,
      };
    }

    // 202 = CAPTCHA required (server didn't send the code)
    if (res.status === 202 || data.captcha_required) {
      return { success: false, message: 'CAPTCHA 验证未通过，请稍后重试' };
    }

    if (!res.ok) {
      return { success: false, message: data.error || '发送失败' };
    }

    return { success: true, message: '验证码已发送' };
  } catch (e) {
    return { success: false, message: '网络错误，请检查连接' };
  }
}

/**
 * Step 2: Verify code and get JWT tokens
 */
export async function verifyCode(email: string, code: string): Promise<LoginResult> {
  try {
    const res = await fetch(`${API_BASE}/auth/verify-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });

    const data = await res.json();

    if (!res.ok) {
      if (data.code === 'INVALID_CODE') {
        return {
          success: false,
          message: `验证码错误，剩余${data.attempts_remaining || 0}次`,
        };
      }
      return { success: false, message: data.error || '验证失败' };
    }

    const accessToken = data.access_token || data.token;
    if (!accessToken) {
      return { success: false, message: '登录异常，未获取到令牌' };
    }

    const user: UserInfo = {
      uid: data.uid || data.user_id || '',
      email,
      nickname: data.nickname || email.split('@')[0],
      avatar: data.avatar,
    };

    await AsyncStorage.multiSet([
      [STORAGE_KEYS.accessToken, accessToken],
      [STORAGE_KEYS.refreshToken, data.refresh_token || ''],
      [STORAGE_KEYS.userInfo, JSON.stringify(user)],
    ]);

    if (user.uid) {
      analytics.identify(user.uid, { email: user.email, login_method: 'email' });
    }
    analytics.capture('mobile_login', { method: 'email', success: true });

    return { success: true, message: '登录成功', user };
  } catch (e) {
    return { success: false, message: '网络错误，请检查连接' };
  }
}

export async function getToken(): Promise<string | null> {
  return AsyncStorage.getItem(STORAGE_KEYS.accessToken);
}

export async function getUserInfo(): Promise<UserInfo | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.userInfo);
  if (!raw) return null;
  try { return JSON.parse(raw) as UserInfo; } catch { return null; }
}

/**
 * Decode a JWT and check whether the `exp` claim has passed.
 * Returns true on any parse failure — we'd rather force a re-login
 * than carry a token we can't reason about.
 */
export function isTokenExpired(token: string): boolean {
  try {
    const part = token.split('.')[1];
    if (!part) return true;
    let b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const decoded = globalThis.atob ? globalThis.atob(b64) : '';
    if (!decoded) return true;
    const payload = JSON.parse(decoded) as { exp?: number };
    if (!payload.exp) return true;
    return payload.exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}

export async function isLoggedIn(): Promise<boolean> {
  const token = await getToken();
  if (!token || token.length === 0) return false;
  if (isTokenExpired(token)) {
    // An expired ACCESS token is normal (30d) while the refresh token is
    // still good (90d) — rotate instead of logging out. Hard-logging-out
    // here wiped the valid RT and forced a QR re-pair every 30 days; the
    // agent 401-retry was the only path that ever refreshed.
    if (await refreshAccessToken()) return true;
    // No RT or rotation refused (revoked/expired) — now it's a real logout.
    await logout();
    return false;
  }
  return true;
}

export async function logout(): Promise<void> {
  analytics.capture('mobile_logout');
  analytics.reset();
  await AsyncStorage.multiRemove([
    STORAGE_KEYS.accessToken,
    STORAGE_KEYS.refreshToken,
    STORAGE_KEYS.userInfo,
  ]);
}

/**
 * Read membership tier + Nepheline (云晶) balance via /v1/license/check.
 * Mobile clients omit X-Device-Fp on purpose — that endpoint will skip the
 * device-binding write path when deviceFp is empty, so this call stays
 * read-only (no risk of accidentally binding the phone as a paid device).
 */
export async function getLicenseStatus(): Promise<LicenseStatus | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}/v1/license/check`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Client-Type': CLIENT_TYPE,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as LicenseStatus;
  } catch {
    return null;
  }
}

/**
 * Exchange a desktop-issued pairing token for a full JWT + refresh token.
 * Desktop generates the token via /auth/pairing/create, renders it as a QR;
 * we scan the QR, POST here, and land in (tabs) authenticated as the same
 * user the desktop is logged in as. Same response shape as /auth/verify-code.
 */
export async function exchangePairingToken(token: string): Promise<LoginResult> {
  try {
    // device_fp/device_name feed the desktop's session manager (设备列表 +
    // 解除配对). Both optional server-side: older builds omitting them get a
    // server-minted fp and a generic name.
    const deviceFp = await getDeviceFp();
    const deviceName = getDeviceName();
    const res = await fetch(`${API_BASE}/auth/pairing/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Type': CLIENT_TYPE },
      body: JSON.stringify({ token, device_fp: deviceFp, device_name: deviceName }),
    });
    const data = await res.json();
    if (!res.ok) {
      const code = data.code || '';
      const message =
        code === 'PAIRING_EXPIRED' ? '二维码已过期，请刷新桌面端' :
        code === 'PAIRING_CLAIMED' ? '二维码已被使用，请重新生成' :
        (data.error || '配对失败');
      return { success: false, message };
    }
    const accessToken = data.token;
    if (!accessToken) return { success: false, message: '配对异常，未获取到令牌' };

    const user: UserInfo = {
      uid: data.user_id || '',
      email: data.email || '',
      nickname: (data.email || '').split('@')[0] || '架构师',
    };
    await AsyncStorage.multiSet([
      [STORAGE_KEYS.accessToken, accessToken],
      [STORAGE_KEYS.refreshToken, data.refresh_token || ''],
      [STORAGE_KEYS.userInfo, JSON.stringify(user)],
    ]);

    if (user.uid) {
      analytics.identify(user.uid, { email: user.email, login_method: 'qr_pairing' });
    }
    analytics.capture('mobile_login', { method: 'qr_pairing', success: true });

    return { success: true, message: '登录成功', user };
  } catch (e) {
    return { success: false, message: '网络错误，请检查连接' };
  }
}

// Single-flight: rotation is single-use server-side (the old RT dies on
// first use), so two concurrent callers — e.g. two screens' focus effects
// both hitting isLoggedIn() — must share one request or the loser burns the
// fresh RT and hard-logs the account out.
let refreshInflight: Promise<boolean> | null = null;

export function refreshAccessToken(): Promise<boolean> {
  if (refreshInflight) return refreshInflight;
  refreshInflight = doRefreshAccessToken().finally(() => { refreshInflight = null; });
  return refreshInflight;
}

async function doRefreshAccessToken(): Promise<boolean> {
  try {
    const refreshToken = await AsyncStorage.getItem(STORAGE_KEYS.refreshToken);
    if (!refreshToken) return false;

    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Type': CLIENT_TYPE },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    const data = await res.json();
    // Server returns {token, refresh_token} (rotation: the old RT is dead the
    // moment the server answers). The old `data.access_token` check never
    // matched and the rotated RT was never stored — one refresh attempt burned
    // the chain and the session hard-died at JWT expiry.
    const newToken = data.token || data.access_token;
    if (!res.ok || !newToken) return false;

    const pairs: [string, string][] = [[STORAGE_KEYS.accessToken, newToken]];
    if (data.refresh_token) pairs.push([STORAGE_KEYS.refreshToken, data.refresh_token]);
    await AsyncStorage.multiSet(pairs);
    return true;
  } catch { return false; }
}
