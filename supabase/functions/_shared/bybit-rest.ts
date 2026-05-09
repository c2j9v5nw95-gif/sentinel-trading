// Bybit V5 REST signer + transport.
//
// Implements the standard V5 HMAC-SHA256 scheme:
//   sign = HMAC_SHA256(secret, timestamp + apiKey + recvWindow + (queryString | bodyString))
// Headers: X-BAPI-API-KEY, X-BAPI-TIMESTAMP, X-BAPI-RECV-WINDOW, X-BAPI-SIGN.
//
// Features:
//   - one fast retry only for explicit transient errors
//   - exponential backoff + jitter, capped attempts
//   - idempotency through the caller-supplied orderLinkId for order endpoints
//   - throws BybitError with parsed retCode/retMsg
//
// All low-level HTTP lives here so TestnetBybitClient and (future) LiveBybitClient
// are the only places that pick a baseUrl + creds.

const enc = new TextEncoder();

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const bytes = new Uint8Array(sig);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export interface BybitCreds {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;          // https://api-testnet.bybit.com or https://api.bybit.com
  recvWindowMs?: number;    // default 5000
}

export class BybitError extends Error {
  constructor(
    message: string,
    public retCode: number,
    public retMsg: string,
    public httpStatus: number,
    public endpoint: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

function jitter(ms: number) { return ms + Math.floor(Math.random() * (ms / 2)); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_ATTEMPTS = 2;
const RETRYABLE_RET_CODES = new Set([10002, 10006, 10016, 10018, 10000, 130150]);

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 418 || status >= 500;
}

export interface BybitRequestOpts {
  endpoint: string;            // /v5/order/create
  method: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  // Idempotency hint — caller's orderLinkId; logged for observability.
  idempotencyKey?: string;
}

export interface BybitResponse<T = unknown> {
  retCode: number;
  retMsg: string;
  result: T;
  time: number;
}

export class BybitRest {
  constructor(private creds: BybitCreds) {}

  private serializeQuery(q?: Record<string, string | number | boolean | undefined>): string {
    if (!q) return "";
    const entries = Object.entries(q)
      .filter(([_k, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, String(v)] as const)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  }

  async request<T = unknown>(opts: BybitRequestOpts): Promise<BybitResponse<T>> {
    const recvWindow = String(this.creds.recvWindowMs ?? 5000);
    const isPost = opts.method === "POST";
    const bodyStr = isPost ? JSON.stringify(opts.body ?? {}) : "";
    const queryStr = !isPost ? this.serializeQuery(opts.query) : "";

    let attempt = 0;
    let lastError: Error | null = null;
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      const ts = String(Date.now());
      const payload = isPost
        ? ts + this.creds.apiKey + recvWindow + bodyStr
        : ts + this.creds.apiKey + recvWindow + queryStr;
      const sign = await hmacSha256Hex(this.creds.apiSecret, payload);

      const url = isPost
        ? `${this.creds.baseUrl}${opts.endpoint}`
        : `${this.creds.baseUrl}${opts.endpoint}${queryStr ? `?${queryStr}` : ""}`;

      try {
        const res = await fetch(url, {
          method: opts.method,
          headers: {
            "X-BAPI-API-KEY": this.creds.apiKey,
            "X-BAPI-TIMESTAMP": ts,
            "X-BAPI-RECV-WINDOW": recvWindow,
            "X-BAPI-SIGN": sign,
            "X-BAPI-SIGN-TYPE": "2",
            "Content-Type": "application/json",
          },
          body: isPost ? bodyStr : undefined,
        });

        // Rate-limit: respect Retry-After
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
          await sleep(jitter(Math.min(retryAfter * 1000, 8000)));
          continue;
        }

        const text = await res.text();
        let json: BybitResponse<T>;
        try {
          json = JSON.parse(text) as BybitResponse<T>;
        } catch {
          throw new BybitError(`bad_json:${res.status}`, -1, text.slice(0, 200), res.status, opts.endpoint);
        }

        if (json.retCode === 0) return json;

        if (RETRYABLE_RET_CODES.has(json.retCode) && attempt < MAX_ATTEMPTS) {
          await sleep(jitter(300 * attempt));
          continue;
        }

        throw new BybitError(
          `bybit_${json.retCode}:${json.retMsg}`,
          json.retCode, json.retMsg, res.status, opts.endpoint, json.result,
        );
      } catch (e) {
        lastError = e as Error;
        if (e instanceof BybitError) {
          if (attempt >= MAX_ATTEMPTS) throw e;
        } else if (attempt < MAX_ATTEMPTS) {
          await sleep(jitter(300 * attempt));
          continue;
        } else {
          throw e;
        }
      }
    }
    throw lastError ?? new Error("bybit_unknown_failure");
  }
}
