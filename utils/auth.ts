import AsyncStorage from '@react-native-async-storage/async-storage';

const API_BASE = 'https://api.arisfusion.com';
const CLIENT_TYPE = 'nephele-mobile-v1';

const STORAGE_KEYS = {
  accessToken: 'nephele_access_token',
  refreshToken: 'nephele_refresh_token',
  userInfo: 'nephele_user_info',
} as const;

export type UserInfo = {
  uid: string;
  email: string;
  nickname: string;
  avatar?: string;
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

export async function isLoggedIn(): Promise<boolean> {
  const token = await getToken();
  return token !== null && token.length > 0;
}

export async function logout(): Promise<void> {
  await AsyncStorage.multiRemove([
    STORAGE_KEYS.accessToken,
    STORAGE_KEYS.refreshToken,
    STORAGE_KEYS.userInfo,
  ]);
}

export async function refreshAccessToken(): Promise<boolean> {
  try {
    const refreshToken = await AsyncStorage.getItem(STORAGE_KEYS.refreshToken);
    if (!refreshToken) return false;

    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    const data = await res.json();
    if (!res.ok || !data.access_token) return false;

    await AsyncStorage.setItem(STORAGE_KEYS.accessToken, data.access_token);
    return true;
  } catch { return false; }
}
