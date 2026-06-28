// Whitelisted public Bybit fetcher routed through the execution bridge VPS.
// ANALYTICS-ONLY. Strict allowlist: kline + tickers + instruments-info. GET only. No signing.
// Never imports execution / dispatcher / live-client code.

import type { Bar } from './indicators';
import { toBybitInterval, type Timeframe } from './timeframe';

const ANALYTICS_PUBLIC_ENDPOINTS = [
  '/v5/market/kline',
  '/v5/market/tickers',
  '/v5/market/instruments-info',
] as const;
type AnalyticsEndpoint = typeof ANALYTICS_PUBLIC_ENDPOINTS[number];

const enc = new TextEncoder();
async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const b = new Uint8Array(sig); let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
async function sha256Hex(payload: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(payload));
  const b = new Uint8Array(buf); let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export interface PublicGetResult {
  ok: boolean;
  http_status: number | null;
  payload: any;
  error?: string;
  raw?: string;
}

export async function publicGet(
  endpoint: AnalyticsEndpoint,
  query: Record<string, string>,
): Promise<PublicGetResult> {
  if (!ANALYTICS_PUBLIC_ENDPOINTS.includes(endpoint)) {
    return { ok: false, http_status: null, payload: null, error: 'endpoint_not_allowed' };
  }
  const bridgeUrl = process.env.EXECUTION_BRIDGE_URL?.trim();
  const bridgeSecret = process.env.EXECUTION_BRIDGE_SECRET?.trim();
  if (!bridgeUrl || !bridgeSecret) {
    return { ok: false, http_status: null, payload: null, error: 'bridge_not_configured' };
  }
  const path = '/v1/bybit-call';
  const url = bridgeUrl.replace(/\/+$/, '') + path;
  const bodyObj = {
    endpoint, method: 'GET', query,
    body: null, idempotencyKey: null,
    label: 'analytics-public', signalId: null,
  };
  const bodyStr = JSON.stringify(bodyObj);
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(bodyStr);
  const sig = await hmacSha256Hex(bridgeSecret, `${ts}.${nonce}.POST.${path}.${bodyHash}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Timestamp': ts,
        'X-Bridge-Nonce': nonce,
        'X-Bridge-Signature': sig,
      },
      body: bodyStr,
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* */ }
    if (!res.ok || !parsed) {
      return { ok: false, http_status: res.status, payload: null, raw: text.slice(0, 300), error: `bridge_http_${res.status}` };
    }
    if (parsed.ok !== true || parsed.ret_code !== 0) {
      return {
        ok: false,
        http_status: parsed.http_status ?? null,
        payload: parsed,
        error: `bybit_${parsed.ret_code ?? 'unknown'}`,
      };
    }
    return { ok: true, http_status: parsed.http_status ?? 200, payload: parsed.result };
  } catch (e) {
    return { ok: false, http_status: null, payload: null, error: `network:${(e as Error).message?.slice(0, 80)}` };
  }
}

/**
 * Fetch klines for a symbol/timeframe. Returns bars oldest-first.
 * Bybit V5 returns newest-first; we reverse.
 */
export async function fetchKline(
  symbol: string,
  tf: Timeframe,
  limit: number,
): Promise<{ ok: true; bars: Bar[] } | { ok: false; error: string; http_status: number | null }> {
  const res = await publicGet('/v5/market/kline', {
    category: 'linear',
    symbol,
    interval: toBybitInterval(tf),
    limit: String(Math.min(Math.max(limit, 1), 1000)),
  });
  if (!res.ok) {
    return { ok: false, error: res.error ?? 'unknown', http_status: res.http_status };
  }
  const list: any[] = res.payload?.list ?? [];
  // Bybit row: [ start, open, high, low, close, volume, turnover ]
  const bars: Bar[] = list.map((row) => ({
    bar_time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  })).filter((b) => Number.isFinite(b.close) && Number.isFinite(b.bar_time));
  bars.reverse();
  return { ok: true, bars };
}
