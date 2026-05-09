// Public (unauthenticated) Bybit market data — used as price/instrument fallback
// when a TradingView alert omits `price`/`close` and no paper_market_prices row
// exists for the symbol.
//
// IMPORTANT: Lovable/Supabase Edge runtime egress lands on CloudFront POPs that
// Bybit's WAF blocks (403). Direct calls to api.bybit.com from the edge function
// fail silently. When `useBridge=true` we route the public GET through the same
// bridge VPS that signs live orders — its fixed IP is whitelisted by Bybit.

const PUBLIC_BASE = "https://api.bybit.com";
const enc = new TextEncoder();

export interface PublicInstrumentRules {
  qtyStep?: number;
  minQty?: number;
  maxLeverage?: number;
}

interface FetchOpts {
  useBridge?: boolean;
  /** Optional sink for structured failure logs (signal_id + symbol context). */
  onError?: (info: {
    symbol: string;
    endpoint: string;
    via: "direct" | "bridge";
    http_status: number | null;
    error_kind: string;
    body_snippet?: string;
  }) => void | Promise<void>;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const bytes = new Uint8Array(sig);
  let out = ""; for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
async function sha256Hex(payload: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(payload));
  const bytes = new Uint8Array(buf);
  let out = ""; for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Fetch a public Bybit endpoint via the bridge VPS (POST /v1/bybit-call with method=GET). */
async function fetchViaBridge(endpoint: string, query: Record<string, string>): Promise<{
  ok: boolean;
  http_status: number | null;
  payload: any;
  raw?: string;
  error?: string;
}> {
  const bridgeUrl = Deno.env.get("EXECUTION_BRIDGE_URL");
  const bridgeSecret = Deno.env.get("EXECUTION_BRIDGE_SECRET");
  if (!bridgeUrl || !bridgeSecret) {
    return { ok: false, http_status: null, payload: null, error: "bridge_not_configured" };
  }
  const path = "/v1/bybit-call";
  const url = bridgeUrl.replace(/\/+$/, "") + path;
  const bodyObj = {
    endpoint,
    method: "GET",
    query,
    body: null,
    idempotencyKey: null,
    label: "public-data",
    signalId: null,
  };
  const bodyStr = JSON.stringify(bodyObj);
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(bodyStr);
  const sigPayload = `${ts}.${nonce}.POST.${path}.${bodyHash}`;
  const signature = await hmacSha256Hex(bridgeSecret, sigPayload);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Timestamp": ts,
        "X-Bridge-Nonce": nonce,
        "X-Bridge-Signature": signature,
      },
      body: bodyStr,
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* non-json */ }
    if (!res.ok || !parsed) {
      return { ok: false, http_status: res.status, payload: null, raw: text.slice(0, 300), error: `bridge_http_${res.status}` };
    }
    // Bridge wraps Bybit response: { ok, http_status, ret_code, ret_msg, result, ... }
    if (parsed.ok !== true || parsed.ret_code !== 0) {
      return { ok: false, http_status: parsed.http_status ?? null, payload: parsed, raw: text.slice(0, 300), error: `bybit_${parsed.ret_code ?? "unknown"}:${parsed.ret_msg ?? ""}`.slice(0, 200) };
    }
    return { ok: true, http_status: parsed.http_status ?? 200, payload: parsed.result };
  } catch (e) {
    return { ok: false, http_status: null, payload: null, error: `bridge_network:${(e as Error).message?.slice(0, 80)}` };
  }
}

async function fetchDirect(endpoint: string, query: Record<string, string>): Promise<{
  ok: boolean;
  http_status: number | null;
  payload: any;
  raw?: string;
  error?: string;
}> {
  const qs = new URLSearchParams(query).toString();
  const url = `${PUBLIC_BASE}${endpoint}${qs ? "?" + qs : ""}`;
  try {
    const res = await fetch(url, { method: "GET" });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, http_status: res.status, payload: null, raw: text.slice(0, 300), error: `http_${res.status}` };
    }
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { return { ok: false, http_status: res.status, payload: null, raw: text.slice(0, 300), error: "bad_json" }; }
    if (parsed?.retCode !== 0) {
      return { ok: false, http_status: res.status, payload: parsed, raw: text.slice(0, 300), error: `bybit_${parsed?.retCode}:${parsed?.retMsg ?? ""}`.slice(0, 200) };
    }
    return { ok: true, http_status: res.status, payload: parsed.result };
  } catch (e) {
    return { ok: false, http_status: null, payload: null, error: `network:${(e as Error).message?.slice(0, 80)}` };
  }
}

export async function fetchLastPrice(symbol: string, opts: FetchOpts = {}): Promise<number | null> {
  const endpoint = "/v5/market/tickers";
  const query = { category: "linear", symbol };
  const via = opts.useBridge ? "bridge" : "direct";
  const res = opts.useBridge ? await fetchViaBridge(endpoint, query) : await fetchDirect(endpoint, query);
  if (!res.ok) {
    if (opts.onError) {
      try {
        await opts.onError({ symbol, endpoint, via, http_status: res.http_status, error_kind: res.error ?? "unknown", body_snippet: res.raw });
      } catch { /* swallow */ }
    }
    console.log(JSON.stringify({ evt: "public_ticker_fail", symbol, via, http_status: res.http_status, error: res.error, body: res.raw }));
    return null;
  }
  const row = res.payload?.list?.[0];
  const px = Number(row?.lastPrice ?? row?.markPrice ?? NaN);
  return Number.isFinite(px) && px > 0 ? px : null;
}

export async function fetchInstrumentRules(symbol: string, opts: FetchOpts = {}): Promise<PublicInstrumentRules | null> {
  const endpoint = "/v5/market/instruments-info";
  const query = { category: "linear", symbol };
  const via = opts.useBridge ? "bridge" : "direct";
  const res = opts.useBridge ? await fetchViaBridge(endpoint, query) : await fetchDirect(endpoint, query);
  if (!res.ok) {
    if (opts.onError) {
      try {
        await opts.onError({ symbol, endpoint, via, http_status: res.http_status, error_kind: res.error ?? "unknown", body_snippet: res.raw });
      } catch { /* swallow */ }
    }
    console.log(JSON.stringify({ evt: "public_instrument_fail", symbol, via, http_status: res.http_status, error: res.error, body: res.raw }));
    return null;
  }
  const row = res.payload?.list?.[0];
  if (!row) return null;
  const qtyStep = Number(row.lotSizeFilter?.qtyStep ?? NaN);
  const minQty = Number(row.lotSizeFilter?.minOrderQty ?? NaN);
  const maxLeverage = Number(row.leverageFilter?.maxLeverage ?? NaN);
  return {
    ...(Number.isFinite(qtyStep) && qtyStep > 0 ? { qtyStep } : {}),
    ...(Number.isFinite(minQty) && minQty > 0 ? { minQty } : {}),
    ...(Number.isFinite(maxLeverage) && maxLeverage > 0 ? { maxLeverage } : {}),
  };
}
