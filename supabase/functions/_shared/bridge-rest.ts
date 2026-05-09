// BridgeBybitRest — drop-in replacement for BybitRest that proxies signed
// Bybit V5 calls through the private execution bridge VPS (fixed IP, Bybit-
// whitelisted). Same `request()` shape as BybitRest, same trace writer hooks
// — so callers (VenueBybitClient) don't know whether the call went direct
// or through the bridge.
//
// Why: Lovable/Supabase Edge runtime egress lands on CloudFront POPs that
// Bybit's WAF blocks (403). The bridge has a fixed public IP that we register
// with Bybit, eliminating the runtime/IP class of failure entirely.
//
// Wire protocol (Supabase -> bridge):
//   POST {BRIDGE_URL}/v1/bybit-call
//   Headers:
//     Content-Type: application/json
//     X-Bridge-Timestamp: <ms epoch>
//     X-Bridge-Nonce: <uuid>
//     X-Bridge-Signature: hex(hmac_sha256(BRIDGE_SECRET,
//                          ts + "." + nonce + "." + method + "." + path + "." + sha256(body)))
//   Body: { endpoint, method, query, body, idempotencyKey, label, signalId }
// Bridge response (200 even on Bybit 4xx/5xx — the call itself succeeded):
//   { ok, http_status, ret_code, ret_msg, result, time, trace: {...} }
// Network/bridge failure: non-200 from bridge -> BybitTransportError(network).

import {
  type BybitRequestOpts,
  type BybitResponse,
  type BybitTrace,
  type BybitTraceWriter,
  BybitError,
  BybitTransportError,
} from "./bybit-rest.ts";

const enc = new TextEncoder();

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

export interface BridgeRestOpts {
  bridgeUrl: string;
  bridgeSecret: string;
  /** Tag identifying caller — "live-executor". Mirrored to bridge for traces. */
  label?: string;
  /** Reuses BybitRest's trace sink so DB rows look identical. */
  traceWriter?: BybitTraceWriter;
}

export class BridgeBybitRest {
  private currentSignalId: string | null = null;

  constructor(private opts: BridgeRestOpts) {
    if (!opts.bridgeUrl) throw new Error("EXECUTION_BRIDGE_URL not configured");
    if (!opts.bridgeSecret) throw new Error("EXECUTION_BRIDGE_SECRET not configured");
  }

  setSignalContext(signalId: string | null) { this.currentSignalId = signalId; }

  async request<T = unknown>(req: BybitRequestOpts): Promise<BybitResponse<T>> {
    const startedAt = Date.now();
    const signalId = req.signalId ?? this.currentSignalId ?? null;
    const label = this.opts.label ?? "live-executor";
    const path = "/v1/bybit-call";
    const url = this.opts.bridgeUrl.replace(/\/+$/, "") + path;

    const bodyObj = {
      endpoint: req.endpoint,
      method: req.method,
      query: req.query ?? null,
      body: req.body ?? null,
      idempotencyKey: req.idempotencyKey ?? null,
      label,
      signalId,
    };
    const bodyStr = JSON.stringify(bodyObj);
    const ts = String(Date.now());
    const nonce = crypto.randomUUID();
    const bodyHash = await sha256Hex(bodyStr);
    const sigPayload = `${ts}.${nonce}.POST.${path}.${bodyHash}`;
    const signature = await hmacSha256Hex(this.opts.bridgeSecret, sigPayload);

    // Pre-trace (logged immediately so a hung bridge still leaves a breadcrumb).
    const baseTrace: BybitTrace = {
      label, attempt: 1,
      base_url: this.opts.bridgeUrl,
      endpoint: req.endpoint,
      method: req.method,
      query: req.query
        ? Object.fromEntries(
            Object.entries(req.query).filter(([_k, v]) => v !== undefined && v !== null && v !== ""),
          )
        : null,
      query_string: null,
      body_keys: req.body ? Object.keys(req.body) : null,
      body_size: bodyStr.length,
      body_sha256_prefix: bodyHash.slice(0, 16),
      recv_window_ms: 5000,
      timestamp_ms: startedAt,
      sign_payload_prefix: `bridge|${ts}|${nonce.slice(0, 8)}|${req.endpoint}`,
      sign_len: signature.length,
      api_key_prefix: "bridge",
      idempotency_key: req.idempotencyKey ?? null,
      signal_id: signalId,
      http_status: null, content_type: null, content_length: null,
      cf_ray: null, server: null, bapi_request_id: null,
      amz_cf_id: null, amz_cf_pop: null, via: null,
      ret_code: null, ret_msg: null, body_snippet: null,
      duration_ms: 0, ok: false, error_kind: null,
    };
    console.log(JSON.stringify({ evt: "bridge_request", ...baseTrace }));

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Timestamp": ts,
          "X-Bridge-Nonce": nonce,
          "X-Bridge-Signature": signature,
          "X-Idempotency-Key": req.idempotencyKey ?? "",
        },
        body: bodyStr,
      });
    } catch (e) {
      const trace = { ...baseTrace,
        duration_ms: Date.now() - startedAt,
        error_kind: `bridge_network:${(e as Error).message?.slice(0, 80) ?? "unknown"}`,
      };
      await this.emitTrace(trace);
      throw new BybitTransportError("network", {
        base_url: this.opts.bridgeUrl, endpoint: req.endpoint,
        http_status: 0, body_snippet: (e as Error).message?.slice(0, 200),
      });
    }

    const text = await res.text();
    let payload: any = null;
    try { payload = JSON.parse(text); } catch { /* non-JSON */ }

    // Bridge failure (non-200): treat as transport error, fail-fast.
    if (!res.ok || !payload) {
      const trace = { ...baseTrace,
        http_status: res.status,
        body_snippet: text.slice(0, 500),
        duration_ms: Date.now() - startedAt,
        error_kind: `bridge_http_${res.status}`,
      };
      await this.emitTrace(trace);
      throw new BybitTransportError(res.status === 403 ? "forbidden" : "bad_json", {
        base_url: this.opts.bridgeUrl, endpoint: req.endpoint,
        http_status: res.status, body_snippet: text.slice(0, 500),
      });
    }

    // Bridge succeeded; payload includes Bybit's actual ret_code + trace.
    const t = payload.trace ?? {};
    const trace: BybitTrace = { ...baseTrace,
      base_url: t.base_url ?? "https://api.bybit.com",
      http_status: payload.http_status ?? null,
      content_type: t.content_type ?? null,
      content_length: t.content_length ?? null,
      cf_ray: t.cf_ray ?? null,
      server: t.server ?? null,
      bapi_request_id: t.bapi_request_id ?? null,
      amz_cf_id: t.amz_cf_id ?? null,
      amz_cf_pop: t.amz_cf_pop ?? null,
      via: t.via ?? null,
      ret_code: payload.ret_code ?? null,
      ret_msg: payload.ret_msg ?? null,
      body_snippet: t.body_snippet ?? null,
      duration_ms: Date.now() - startedAt,
      ok: payload.ok === true && payload.ret_code === 0,
      error_kind: payload.ok && payload.ret_code === 0 ? null : `bridge_relay:${payload.ret_code ?? "unknown"}`,
    };
    await this.emitTrace(trace);

    // Bridge says Bybit returned non-JSON or 4xx body — surface as transport error.
    if (payload.ok === false && payload.transport_error) {
      throw new BybitTransportError(payload.transport_error.kind ?? "bad_json", {
        base_url: trace.base_url, endpoint: req.endpoint,
        http_status: payload.http_status ?? 0,
        cf_ray: trace.cf_ray ?? undefined,
        server: trace.server ?? undefined,
        body_snippet: trace.body_snippet ?? undefined,
      });
    }

    const json: BybitResponse<T> = {
      retCode: payload.ret_code ?? -1,
      retMsg: payload.ret_msg ?? "bridge_unknown",
      result: payload.result as T,
      time: payload.time ?? Date.now(),
    };
    if (json.retCode !== 0) {
      throw new BybitError(
        `bybit_${json.retCode}:${json.retMsg}`,
        json.retCode, json.retMsg, payload.http_status ?? 0, req.endpoint, json.result,
      );
    }
    return json;
  }

  private async emitTrace(trace: BybitTrace) {
    console.log(JSON.stringify({ evt: "bridge_trace", ...trace }));
    if (this.opts.traceWriter) {
      try { await this.opts.traceWriter(trace); }
      catch (e) { console.log(JSON.stringify({ evt: "bridge_trace_writer_error", message: (e as Error).message })); }
    }
  }
}

/** True iff the bridge is configured and live mode should route through it. */
export function bridgeConfigured(): boolean {
  return !!(Deno.env.get("EXECUTION_BRIDGE_URL") && Deno.env.get("EXECUTION_BRIDGE_SECRET"));
}
