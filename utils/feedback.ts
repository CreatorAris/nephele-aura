// Aura in-app feedback ("意见反馈") — mirrors the desktop's submitFeedback
// (core/bridge/ui_bridge.py) against the same JWT-gated Worker route
// POST /v1/feedback. The Worker stamps uid/email/tier/country from the JWT, so
// client-supplied identity is never trusted; we only attach cheap known context
// (version / channel / os) plus an optional self-check snapshot.
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { getToken } from './auth';
import type { DiagReport } from './diagnostics';
import analytics from './analytics';

const API_BASE = 'https://api.arisfusion.com';
const CLIENT_TYPE = 'nephele-aura';

export type FeedbackResult = {
  success: boolean;
  code?: string;
  message?: string;
};

// Server caps body at 4000 chars and diagnostics at 16 KB; clamp client-side so
// the request is well-formed before it leaves the device.
const MAX_BODY = 4000;

/**
 * Submit a feedback report. Requires email login (the server re-enforces via
 * JWT). `diagnostics` is the envelope from runDiagnostics(); pass it only when
 * the user opted to attach their self-check snapshot.
 */
export async function submitFeedback(
  category: string,
  body: string,
  diagnostics?: DiagReport | null,
): Promise<FeedbackResult> {
  const cat = (category || 'other').trim() || 'other';
  const text = (body || '').trim().slice(0, MAX_BODY);
  if (!text) return { success: false, code: 'EMPTY', message: '反馈内容不能为空' };

  const token = await getToken();
  if (!token) return { success: false, code: 'AUTH_REQUIRED', message: '请先登录后再反馈' };

  analytics.capture('feedback_submitted', { category: cat, length: text.length });

  try {
    const payload: Record<string, unknown> = {
      category: cat,
      body: text,
      context: {
        version: Constants.expoConfig?.version ?? '',
        channel: __DEV__ ? 'dev' : 'aura',
        os: `${Platform.OS} ${Platform.Version ?? ''}`.trim(),
      },
    };
    if (diagnostics && Array.isArray(diagnostics.items) && diagnostics.items.length) {
      payload.diagnostics = diagnostics;
    }

    const res = await fetch(`${API_BASE}/v1/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Client-Type': CLIENT_TYPE,
      },
      body: JSON.stringify(payload),
    });

    const data = (await res.json().catch(() => ({}))) as FeedbackResult;
    if (res.status === 200 && data.success) {
      analytics.capture('feedback_succeeded', { category: cat });
      return { success: true, message: data.message || '已收到，感谢反馈' };
    }
    const code = data.code || `HTTP_${res.status}`;
    analytics.capture('feedback_failed', { category: cat, code });
    return { success: false, code, message: data.message || '提交失败，请稍后重试' };
  } catch {
    analytics.capture('feedback_failed', { category: cat, code: 'NETWORK' });
    return { success: false, code: 'NETWORK', message: '提交失败，请检查网络' };
  }
}
