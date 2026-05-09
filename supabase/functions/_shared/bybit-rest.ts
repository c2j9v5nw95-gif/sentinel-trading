// Bybit V5 REST signer + transport.
//
// Implements the standard V5 HMAC-SHA256 scheme:
//   sign = HMAC_SHA256(secret, timestamp + apiKey + recvWindow + (queryString | bodyString))
// Headers: X-BAPI-API-KEY, X-BAPI-TIMESTAMP, X-BAPI-RECV-WINDOW, X-BAPI-SIGN.

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

async function sha256Hex(payload: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(payload));
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export interface BybitTrace {
  label: string;
  attempt: number;
  base_url: string;
  endpoint: string;
  method: "GET" | "POST";
  query: Record<string, unknown> | null;
  query_string: string | null;
  body_keys: string[] | null;
  body_size: number;
  body_sha256_prefix: string | null;
  recv_window_ms: number;
  timestamp_ms: number;
  sign_payload_prefix: string;
  sign_len: number;
  api_key_prefix: string;
  idempotency_key: string | null;
  signal_id: string | null;
  // response side (filled in after fetch resolves):
  http_status: number | null;
  content_type: string | null;
  content_length: number | null;
  cf_ray: string | null;
  server: string | null;
  bapi_request_id: string | null;
  amz_cf_id: string | null;
  amz_cf_pop: string | null;
  via: string | null;
  ret_code: number | null;
  ret_msg: string | null;
  body_snippet: string | null;
  duration_ms: number;
  ok: boolean;
  error_kind: string | null;
}

export type BybitTraceWriter = (trace: BybitTrace) => void | Promise<void>;

export interface BybitCreds {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  recvWindowMs?: number;
  /** Tag identifying caller — "diag-live" | "live-executor" | "testnet-executor". */
  label?: string;
  /** Optional sink for full per-call trace (DB row, log aggregator, etc.). */
  traceWriter?: BybitTraceWriter;
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

export interface BybitTransportDiagnostics {
  base_url: string;
  endpoint: string;
  http_status: number;
  content_type?: string;
  cf_ray?: string;
  server?: string;
  request_id?: string;
  body_snippet?: string;
}

export class BybitTransportError extends Error {
  constructor(
    public kind: "forbidden" | "bad_json" | "network",
    public diagnostics: BybitTransportDiagnostics,
  ) {
    super(`bybit_transport_${kind}:${diagnostics.http_status}:${diagnostics.endpoint}`);
  }
}

function jitter(ms: number) { return ms + Math.floor(Math.random() * (ms / 2)); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RETRYABLE_RET_CODES = new Set([10002, 10006, 10016, 10018, 10000, 130150]);
const AUDIT_NO_RETRY_ENDPOINTS = new Set(["/v5/position/list", "/v5/order/create"]);

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 418 || status >= 500;
}

function maxAttemptsFor(endpoint: string): number {
  // While auditing, force fail-fast on the two endpoints we are isolating.
  if (Deno.env.get("BYBIT_AUDIT_MODE") === "1" && AUDIT_NO_RETRY_ENDPOINTS.has(endpoint)) return 1;
  return 2;
}

export interface BybitRequestOpts {
  endpoint: string;
  method: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  /** Optional per-call signal context — used by trace writer / DB row. */
  signalId?: string;
}

export interface BybitResponse<T = unknown> {
  retCode: number;
  retMsg: string;
  result: T;
  time: number;
}

export class BybitRest {
  /** Per-instance signal id — set by callers that want every subsequent call tagged. */
  private currentSignalId: string | null = null;

  constructor(private creds: BybitCreds) {}

  setSignalContext(signalId: string | null) { this.currentSignalId = signalId; }

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
    const label = this.creds.label ?? "unknown";
    const signalId = opts.signalId ?? this.currentSignalId ?? null;
    const maxAttempts = maxAttemptsFor(opts.endpoint);

    let attempt = 0;
    let lastError: Error | null = null;
    while (attempt < maxAttempts) {
      attempt++;
      const startedAt = Date.now();
      const ts = String(startedAt);
      const payload = isPost
        ? ts + this.creds.apiKey + recvWindow + bodyStr
        : ts + this.creds.apiKey + recvWindow + queryStr;
      const sign = await hmacSha256Hex(this.creds.apiSecret, payload);
      const bodyHash = bodyStr ? (await sha256Hex(bodyStr)).slice(0, 16) : null;

      const url = isPost
        ? `${this.creds.baseUrl}${opts.endpoint}`
        : `${this.creds.baseUrl}${opts.endpoint}${queryStr ? `?${queryStr}` : ""}`;

      // Sign-payload prefix: redact the actual API key in the middle of the
      // string (only its prefix is shown). Format: ts|<keyPrefix>***|recv|...
      const apiKeyPrefix = this.creds.apiKey.slice(0, 4) + "***";
      const trailing = isPost ? bodyStr.slice(0, 80) : queryStr.slice(0, 80);
      const signPayloadPrefix = `${ts}|${apiKeyPrefix}|${recvWindow}|${trailing}`;

      const trace: BybitTrace = {
        label, attempt,
        base_url: this.creds.baseUrl,
        endpoint: opts.endpoint,
        method: opts.method,
        query: opts.query
          ? Object.fromEntries(
              Object.entries(opts.query).filter(([_k, v]) => v !== undefined && v !== null && v !== ""),
            )
          : null,
        query_string: queryStr || null,
        body_keys: opts.body ? Object.keys(opts.body) : null,
        body_size: bodyStr.length || 0,
        body_sha256_prefix: bodyHash,
        recv_window_ms: Number(recvWindow),
        timestamp_ms: startedAt,
        sign_payload_prefix: signPayloadPrefix,
        sign_len: sign.length,
        api_key_prefix: apiKeyPrefix,
        idempotency_key: opts.idempotencyKey ?? null,
        signal_id: signalId,
        http_status: null, content_type: null, content_length: null,
        cf_ray: null, server: null, bapi_request_id: null,
        amz_cf_id: null, amz_cf_pop: null, via: null,
        ret_code: null, ret_msg: null, body_snippet: null,
        duration_ms: 0, ok: false, error_kind: null,
      };

      // Always log request side immediately so even network hangs leave a trace.
      console.log(JSON.stringify({ evt: "bybit_request", ...trace }));

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

        trace.http_status = res.status;
        trace.content_type = res.headers.get("content-type");
        const cl = res.headers.get("content-length");
        trace.content_length = cl ? Number(cl) : null;
        trace.cf_ray = res.headers.get("cf-ray");
        trace.server = res.headers.get("server");
        trace.bapi_request_id = res.headers.get("x-bapi-request-id") ?? res.headers.get("x-request-id");
        trace.amz_cf_id = res.headers.get("x-amz-cf-id");
        trace.amz_cf_pop = res.headers.get("x-amz-cf-pop");
        trace.via = res.headers.get("via");

        if (isRetryableHttpStatus(res.status) && attempt < maxAttempts) {
          const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
          const delayMs = res.status === 429 ? Math.min(retryAfter * 250, 750) : 250 * attempt;
          trace.duration_ms = Date.now() - startedAt;
          trace.error_kind = `retryable_http_${res.status}`;
          await this.emitTrace(trace);
          await sleep(jitter(delayMs));
          continue;
        }

        const text = await res.text();
        let json: BybitResponse<T> | null = null;
        try { json = JSON.parse(text) as BybitResponse<T>; } catch { /* non-JSON */ }

        if (json === null) {
          trace.body_snippet = text.slice(0, 500);
          trace.duration_ms = Date.now() - startedAt;
          const kind: "forbidden" | "bad_json" = res.status === 403 ? "forbidden" : "bad_json";
          trace.error_kind = `transport_${kind}`;
          await this.emitTrace(trace);
          throw new BybitTransportError(kind, {
            base_url: trace.base_url,
            endpoint: trace.endpoint,
            http_status: res.status,
            content_type: trace.content_type ?? undefined,
            cf_ray: trace.cf_ray ?? undefined,
            server: trace.server ?? undefined,
            request_id: trace.bapi_request_id ?? undefined,
            body_snippet: trace.body_snippet ?? undefined,
          });
        }

        trace.ret_code = json.retCode;
        trace.ret_msg = json.retMsg;
        trace.duration_ms = Date.now() - startedAt;

        if (json.retCode === 0) {
          trace.ok = true;
          await this.emitTrace(trace);
          return json;
        }

        if (RETRYABLE_RET_CODES.has(json.retCode) && attempt < maxAttempts) {
          trace.error_kind = `retryable_ret_${json.retCode}`;
          await this.emitTrace(trace);
          await sleep(jitter(300 * attempt));
          continue;
        }

        // Capture body snippet on non-zero retCode for post-mortem.
        trace.body_snippet = text.slice(0, 500);
        trace.error_kind = `bybit_${json.retCode}`;
        await this.emitTrace(trace);
        throw new BybitError(
          `bybit_${json.retCode}:${json.retMsg}`,
          json.retCode, json.retMsg, res.status, opts.endpoint, json.result,
        );
      } catch (e) {
        lastError = e as Error;
        if (e instanceof BybitTransportError) throw e;
        if (e instanceof BybitError) {
          const retryable = isRetryableHttpStatus(e.httpStatus) || RETRYABLE_RET_CODES.has(e.retCode);
          if (retryable && attempt < maxAttempts) { await sleep(jitter(250 * attempt)); continue; }
          throw e;
        } else if (attempt < maxAttempts) {
          // Network-level failure (fetch threw). Log the partial trace.
          trace.duration_ms = Date.now() - startedAt;
          trace.error_kind = `network:${(e as Error).message?.slice(0, 80) ?? "unknown"}`;
          await this.emitTrace(trace);
          await sleep(jitter(300 * attempt));
          continue;
        } else {
          trace.duration_ms = Date.now() - startedAt;
          trace.error_kind = `network_final:${(e as Error).message?.slice(0, 80) ?? "unknown"}`;
          await this.emitTrace(trace);
          throw e;
        }
      }
    }
    throw lastError ?? new Error("bybit_unknown_failure");
  }

  private async emitTrace(trace: BybitTrace) {
    console.log(JSON.stringify({ evt: "bybit_trace", ...trace }));
    if (this.creds.traceWriter) {
      try { await this.creds.traceWriter(trace); }
      catch (e) { console.log(JSON.stringify({ evt: "bybit_trace_writer_error", message: (e as Error).message })); }
    }
  }
}
