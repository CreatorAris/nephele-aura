// Aura system self-check — the mobile analog of the desktop's
// runSystemDiagnostics (core/bridge/ui_bridge.py). Same envelope shape
//   { items: [{ key, label, detail, status, hint }], summary: {...} }
// so the feedback flow can attach it verbatim and the Worker's /v1/feedback
// diagLine parser (which reads summary.headline + the `system` item) keeps
// working unchanged across both clients.
//
// The probes are mobile-relevant (device / OTA runtime / cloud reachability /
// desktop relay / push), not the desktop's GPU / ONNX / FFmpeg / browser set —
// none of those exist on a thin RN client. status ∈ "ok" | "warn" | "missing".
import * as Device from 'expo-device';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { getToken, getUserInfo } from './auth';
import { getPushConsent } from './push';
import { remoteWS } from './websocket';
import analytics from './analytics';

const API_BASE = 'https://api.arisfusion.com';
const CLIENT_TYPE = 'nephele-aura';

export type DiagStatus = 'ok' | 'warn' | 'missing';

export type DiagItem = {
  key: string;
  label: string;
  detail: string;
  status: DiagStatus;
  hint: string;
};

export type DiagReport = {
  items: DiagItem[];
  summary: { ok: number; warn: number; missing: number; headline: string };
};

const COUNTRY_NAMES: Record<string, string> = {
  CN: '中国', HK: '香港', TW: '台湾', US: '美国', JP: '日本', KR: '韩国',
  SG: '新加坡', GB: '英国', DE: '德国', CA: '加拿大', AU: '澳大利亚', FR: '法国',
};

/**
 * Run the full self-check. Network probes fail soft — a single unreachable
 * endpoint downgrades its own row to warn, never throws. Returns the same
 * envelope the desktop emits via systemDiagnosticsReady.
 */
export async function runDiagnostics(): Promise<DiagReport> {
  const items: DiagItem[] = [];

  // 1. Device — model + OS + RAM. Low RAM is the mobile analog of the
  //    desktop's "内存偏小" warn (local image decoding / large galleries).
  try {
    const model = Device.modelName || Device.deviceName || '未知设备';
    const os = `${Device.osName ?? Platform.OS} ${Device.osVersion ?? ''}`.trim();
    const ramGb = Device.totalMemory ? Math.round(Device.totalMemory / 1024 ** 3) : 0;
    let detail = `${model} · ${os}`;
    if (ramGb) detail += ` · ${ramGb} GB`;
    const status: DiagStatus = ramGb && ramGb < 3 ? 'warn' : 'ok';
    items.push({
      key: 'system', label: '设备', detail, status,
      hint: status === 'warn' ? '内存偏小，大图浏览可能卡顿' : '',
    });
  } catch {
    /* device info is best-effort */
  }

  // 2. Runtime — app version + build + OTA runtime fingerprint. This is the
  //    forward-looking row for OTA: the runtimeVersion is what the update
  //    manifest is matched against, so a bug report can show exactly which
  //    JS bundle / native shell the user is on.
  try {
    const ver = Constants.expoConfig?.version ?? '未知';
    const build = __DEV__ ? '开发版' : '正式版';
    const rtv = Updates.runtimeVersion || '—';
    items.push({
      key: 'runtime', label: '版本',
      detail: `v${ver} · ${build} · rtv ${rtv}`,
      status: 'ok', hint: '',
    });
  } catch {
    /* version info is best-effort */
  }

  // 2b. Currently-running JS bundle — updateId + publish time. Lets a dev (or a
  //     bug report) tell exactly which OTA bundle is live; a null updateId means
  //     the embedded bundle is running (no OTA applied yet). End users never look
  //     here — OTA itself stays silent.
  try {
    const uid = Updates.updateId;
    const created = Updates.createdAt;
    items.push({
      key: 'bundle', label: 'JS 包',
      detail: uid
        ? `${uid.slice(0, 8)}… · ${created ? created.toLocaleString() : '—'}`
        : '内置包（未 OTA）',
      status: 'ok', hint: '',
    });
  } catch {
    /* bundle info is best-effort */
  }

  // 3. OTA channel — whether self-update is wired up on this build. Disabled
  //    is expected in dev (__DEV__), informational in a release build.
  try {
    const enabled = Updates.isEnabled;
    if (enabled) {
      const channel = Updates.channel || '默认';
      items.push({
        key: 'ota', label: '自动更新', detail: `已启用 · ${channel}`,
        status: 'ok', hint: '',
      });
    } else {
      items.push({
        key: 'ota', label: '自动更新',
        detail: __DEV__ ? '开发模式未启用' : '未启用',
        status: __DEV__ ? 'ok' : 'warn',
        hint: __DEV__ ? '' : '此构建收不到 OTA 更新',
      });
    }
  } catch {
    /* updates module is best-effort */
  }

  // 4. Account — login state. Cloud features + sync need email login.
  try {
    const token = await getToken();
    if (token) {
      const info = await getUserInfo();
      items.push({
        key: 'account', label: '账号',
        detail: info?.email || '已登录', status: 'ok', hint: '',
      });
    } else {
      items.push({
        key: 'account', label: '账号', detail: '未登录',
        status: 'warn', hint: '云端功能与同步需要登录',
      });
    }
  } catch {
    /* auth read is best-effort */
  }

  // 5. Cloud endpoint — reachability + latency via the unauthenticated
  //    /v1/geo probe (doubles as the geo source in step 6).
  let geo: { country?: string; region?: string; colo?: string } | null = null;
  try {
    const t0 = Date.now();
    const res = await fetch(`${API_BASE}/v1/geo`, {
      method: 'GET', headers: { 'X-Client-Type': CLIENT_TYPE },
    });
    const ms = Date.now() - t0;
    if (res.ok) {
      geo = await res.json().catch(() => null);
      if (ms > 1200) {
        items.push({
          key: 'cloud', label: '云端节点', detail: `${ms}ms`,
          status: 'warn', hint: '延迟较高',
        });
      } else {
        items.push({
          key: 'cloud', label: '云端节点', detail: `${ms}ms`,
          status: 'ok', hint: '',
        });
      }
    } else {
      items.push({
        key: 'cloud', label: '云端节点', detail: `HTTP ${res.status}`,
        status: 'warn', hint: '云端响应异常',
      });
    }
  } catch {
    items.push({
      key: 'cloud', label: '云端节点', detail: '连不上',
      status: 'warn', hint: '检查网络或稍后重试',
    });
  }

  // 6. Network position — exit-IP geo (reuses the /v1/geo body from step 5).
  if (geo) {
    const cc = (geo.country || '').toUpperCase();
    const country = COUNTRY_NAMES[cc] || cc || '未知';
    const loc = [country, geo.region].filter(Boolean).join(' · ') || '未知';
    items.push({ key: 'geo', label: '网络位置', detail: loc, status: 'ok', hint: '' });
  }

  // 7. Desktop link — WS relay to the desktop Workshop. Standalone use is
  //    fine, so an offline desktop is informational (ok), not a fault.
  try {
    const state = remoteWS.getState();
    const desktopOnline = remoteWS.getDesktopOnline();
    const transport = remoteWS.getTransport();
    const tLabel = transport === 'lan' ? '局域网直连' : transport === 'relay' ? '服务器中转' : '';
    let detail: string;
    if (state === 'connected' && desktopOnline) detail = tLabel ? `在线 · ${tLabel}` : '在线';
    else if (state === 'connected') detail = '桌面端离线';
    else if (state === 'connecting') detail = '连接中';
    else detail = '未连接';
    items.push({ key: 'desktop', label: '桌面端', detail, status: 'ok', hint: '' });
  } catch {
    /* ws read is best-effort */
  }

  // 8. Push — notification consent state (no fault, just informational).
  try {
    const consent = await getPushConsent();
    const detail = consent === 'granted' ? '已开启' : consent === 'denied' ? '已关闭' : '未设置';
    items.push({ key: 'push', label: '更新推送', detail, status: 'ok', hint: '' });
  } catch {
    /* push read is best-effort */
  }

  // 9. Analytics — telemetry opt-in state.
  try {
    const on = !analytics.isOptedOut();
    items.push({
      key: 'analytics', label: '使用数据',
      detail: on ? '已开启（匿名）' : '已关闭', status: 'ok', hint: '',
    });
  } catch {
    /* analytics read is best-effort */
  }

  const ok = items.filter((i) => i.status === 'ok').length;
  const warn = items.filter((i) => i.status === 'warn').length;
  const missing = items.filter((i) => i.status === 'missing').length;
  const headline = missing ? `${missing} 项缺失` : warn ? `${warn} 项需注意` : '全部就绪';

  return { items, summary: { ok, warn, missing, headline } };
}
