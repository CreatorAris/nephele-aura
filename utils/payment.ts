import analytics from './analytics';
import { getToken } from './auth';

const API_BASE = 'https://api.arisfusion.com';
const CLIENT_TYPE = 'nephele-mobile-v1';

// Backend keeps the legacy `credits` naming for what user-facing copy calls
// 云晶 (Nepheline); `amount_cents` is fen, `currency` is CNY.
export type CatalogProduct = {
  name: string;
  amount_cents: number;
  display_price?: string;   // pre-formatted price ("￥30"); fall back to amount_cents/100
  kind?: string;            // "license" | "credits"
  tier?: string;
  credits_granted?: number;
  visible?: boolean;
};

export type Catalog = {
  version: number;
  currency: string;
  products: Record<string, CatalogProduct>;
};

export async function getCatalog(): Promise<Catalog | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/payment/catalog`, {
      headers: { 'X-Client-Type': CLIENT_TYPE },
    });
    if (!res.ok) return null;
    return (await res.json()) as Catalog;
  } catch {
    return null;
  }
}

export type CreateOrderResult = {
  success: boolean;
  message: string;
  payUrl?: string;
  outTradeNo?: string;
};

/**
 * Create an Alipay 手机网站(WAP) order and return the H5 cashier URL. Open
 * payUrl with Linking.openURL (system browser), NOT an in-app webview — the
 * WAP page hands off to the Alipay app via alipays:// which the system browser
 * resolves and an embedded webview does not.
 */
export async function createAlipayOrder(product: string): Promise<CreateOrderResult> {
  const token = await getToken();
  if (!token) return { success: false, message: '请先登录' };
  try {
    const res = await fetch(`${API_BASE}/v1/payment/alipay/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Client-Type': CLIENT_TYPE,
      },
      body: JSON.stringify({ product }),
    });
    const data = await res.json();
    if (!res.ok || !data.pay_url) {
      return { success: false, message: data.error || '创建订单失败' };
    }
    analytics.capture('mobile_payment_create', { product, method: 'alipay' });
    return { success: true, message: '', payUrl: data.pay_url, outTradeNo: data.out_trade_no };
  } catch {
    return { success: false, message: '网络错误，请检查连接' };
  }
}

export type OrderStatus = 'paid' | 'failed' | 'pending' | 'not_found';

/**
 * Poll order state. Settlement happens server-side via the Alipay notify
 * webhook; this only reads the resulting KV state (IDOR-guarded by uid on the
 * server). Returns 'pending' on transient errors so callers keep polling.
 */
export async function getPaymentStatus(outTradeNo: string): Promise<OrderStatus> {
  const token = await getToken();
  if (!token) return 'not_found';
  try {
    const res = await fetch(
      `${API_BASE}/v1/payment/status?out_trade_no=${encodeURIComponent(outTradeNo)}`,
      { headers: { Authorization: `Bearer ${token}`, 'X-Client-Type': CLIENT_TYPE } },
    );
    if (!res.ok) return 'pending';
    const data = await res.json();
    return (data.status as OrderStatus) || 'pending';
  } catch {
    return 'pending';
  }
}
