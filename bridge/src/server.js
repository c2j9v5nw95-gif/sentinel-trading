// Lovable Bybit Execution Bridge.
//
// Runs on a fixed-IP VPS whitelisted in the Bybit API key. Receives signed
// proxy calls from Supabase edge functions and performs the actual signed
// Bybit V5 REST request, returning a structured response with full trace.
//
// Endpoints:
//   GET  /v1/health           -> { ok, version, public_ip, region, bybit_reachable, uptime_s }
//   POST /v1/bybit-call       -> proxies any V5 endpoint (whitelisted)
//
// All requests require:
//   X-Bridge-Timestamp, X-Bridge-Nonce, X-Bridge-Signature
//
// ENV (see bridge/README.md):
//   PORT, BRIDGE_SECRET, BYBIT_API_BASE_URL,
//   BYBIT_LIVE_API_KEY, BYBIT_LIVE_API_SECRET, BRIDGE_REGION
import Fastify from "fastify";
import { request as undiciRequest, Agent } from "undici";
import { LRUCache } from "lru-cache";
import { signV5, serializeQuery } from "./bybit-signer.js";
import { verifyBridgeSignature } from "./auth.js";

const VERSION = "bridge-2026-05-09-v1";
const PORT = Number(process.env.PORT ?? 8787);
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "";
const BYBIT_BASE = (process.env.BYBIT_API_BASE_URL ?? "https://api.bybit.com").replace(/\/+$/, "");
const API_KEY = process.env.BYBIT_LIVE_API_KEY ?? "";
const API_SECRET = process.env.BYBIT_LIVE_API_SECRET ?? "";
const REGION = process.env.BRIDGE_REGION ?? "unknown";
const RECV_WINDOW = String(process.env.BYBIT_RECV_WINDOW_MS ?? 5000);

const ALLOWED_ENDPOINTS = new Set([
  "/v5/position/list",
  "/v5/order/create",
  "/v5/order/cancel",
  "/v5/execution/list",
  "/v5/position/set-leverage",
  "/v5/position/trading-stop",
  "/v5/account/wallet-balance",
  // analytics — public GET market data only (read-only, no signing required by Bybit)
  "/v5/market/kline",
  "/v5/market/tickers",
]);

if (!BRIDGE_SECRET) { console.error("BRIDGE_SECRET not set — refusing to start"); process.exit(1); }
if (!API_KEY || !API_SECRET) { console.error("BYBIT_LIVE_API_KEY/SECRET not set"); process.exit(1); }

const bootedAt = Date.now();
const dispatcher = new Agent({ connect: { timeout: 8000 }, headersTimeout: 12000, bodyTimeout: 12000 });
// Idempotency cache: orderLinkId -> previous response (5 min).
const idempotencyCache = new LRUCache({ max: 5_000, ttl: 5 * 60 * 1000 });

const fastify = Fastify({ logger: { level: "info" } });

let cachedPublicIp = null;
async function detectPublicIp() {
  if (cachedPublicIp) return cachedPublicIp;
  try {
    const r = await undiciRequest("https://api.ipify.org?format=json", { dispatcher });
    const j = await r.body.json();
    cachedPublicIp = j.ip ?? null;
  } catch { cachedPublicIp = null; }
  return cachedPublicIp;
}

// --- Auth preHandler ---
async function authGuard(req, reply) {
  let raw = "";
  if (req.method !== "GET" && req.method !== "HEAD") {
    raw = req.rawBody ?? JSON.stringify(req.body ?? "");
  }
  const v = verifyBridgeSignature({
    secret: BRIDGE_SECRET,
    method: req.method,
    path: req.url.split("?")[0],
    ts: req.headers["x-bridge-timestamp"],
    nonce: req.headers["x-bridge-nonce"],
    signature: req.headers["x-bridge-signature"],
    body: raw,
  });
  if (!v.ok) {
    req.log.warn({ reason: v.reason, path: req.url }, "auth_reject");
    reply.code(401).send({ ok: false, error: v.reason });
    return reply;
  }
}

// Capture rawBody for signature verification.
fastify.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  req.rawBody = body;
  try { done(null, body.length ? JSON.parse(body) : {}); }
  catch (err) { done(err, undefined); }
});

// --- Health ---
fastify.get("/v1/health", { preHandler: authGuard }, async () => {
  const ip = await detectPublicIp();
  // Lightweight Bybit reachability probe (public endpoint, no signing).
  let bybitReachable = false;
  try {
    const r = await undiciRequest(`${BYBIT_BASE}/v5/market/time`, { method: "GET", dispatcher });
    bybitReachable = r.statusCode === 200;
    await r.body.dump();
  } catch { bybitReachable = false; }
  return {
    ok: true,
    version: VERSION,
    public_ip: ip,
    region: REGION,
    bybit_reachable: bybitReachable,
    bybit_base_url: BYBIT_BASE,
    uptime_s: Math.round((Date.now() - bootedAt) / 1000),
  };
});

// --- Bybit proxy ---
fastify.post("/v1/bybit-call", { preHandler: authGuard }, async (req, reply) => {
  const { endpoint, method, query, body, idempotencyKey, label, signalId } = req.body ?? {};
  if (!endpoint || !method) return reply.code(400).send({ ok: false, error: "missing_endpoint_or_method" });
  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return reply.code(403).send({ ok: false, error: "endpoint_not_whitelisted", endpoint });
  }
  if (method !== "GET" && method !== "POST") {
    return reply.code(400).send({ ok: false, error: "bad_method" });
  }

  // Idempotent replay for order mutations.
  if (idempotencyKey && idempotencyCache.has(idempotencyKey)) {
    const cached = idempotencyCache.get(idempotencyKey);
    return reply.send({ ...cached, idempotent_replay: true });
  }

  const isPost = method === "POST";
  const bodyStr = isPost ? JSON.stringify(body ?? {}) : "";
  const queryStr = !isPost ? serializeQuery(query) : "";
  const ts = String(Date.now());
  const sign = signV5({
    apiKey: API_KEY, apiSecret: API_SECRET, ts, recvWindow: RECV_WINDOW,
    payloadStr: isPost ? bodyStr : queryStr,
  });
  const url = isPost ? `${BYBIT_BASE}${endpoint}` : `${BYBIT_BASE}${endpoint}${queryStr ? `?${queryStr}` : ""}`;
  const startedAt = Date.now();

  let res, text;
  try {
    res = await undiciRequest(url, {
      method,
      headers: {
        "X-BAPI-API-KEY": API_KEY,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "X-BAPI-SIGN": sign,
        "X-BAPI-SIGN-TYPE": "2",
        "Content-Type": "application/json",
      },
      body: isPost ? bodyStr : undefined,
      dispatcher,
    });
    text = await res.body.text();
  } catch (e) {
    req.log.error({ err: e?.message, endpoint }, "bybit_network_failure");
    return reply.send({
      ok: false,
      transport_error: { kind: "network", message: e?.message ?? "fetch_failed" },
      http_status: 0,
      ret_code: null, ret_msg: null, result: null, time: Date.now(),
      trace: { base_url: BYBIT_BASE, duration_ms: Date.now() - startedAt },
    });
  }

  const headers = res.headers;
  const trace = {
    base_url: BYBIT_BASE,
    content_type: headers["content-type"] ?? null,
    content_length: headers["content-length"] ? Number(headers["content-length"]) : null,
    cf_ray: headers["cf-ray"] ?? null,
    server: headers["server"] ?? null,
    bapi_request_id: headers["x-bapi-request-id"] ?? headers["x-request-id"] ?? null,
    amz_cf_id: headers["x-amz-cf-id"] ?? null,
    amz_cf_pop: headers["x-amz-cf-pop"] ?? null,
    via: headers["via"] ?? null,
    duration_ms: Date.now() - startedAt,
  };

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* */ }

  if (!parsed) {
    // Non-JSON body (Cloudflare/WAF block). Should not happen from a whitelisted IP.
    const out = {
      ok: false,
      transport_error: { kind: res.statusCode === 403 ? "forbidden" : "bad_json" },
      http_status: res.statusCode,
      ret_code: null, ret_msg: null, result: null, time: Date.now(),
      trace: { ...trace, body_snippet: text.slice(0, 500) },
    };
    req.log.warn({ endpoint, http_status: res.statusCode, snippet: text.slice(0, 200) }, "bybit_non_json");
    return reply.send(out);
  }

  const out = {
    ok: parsed.retCode === 0,
    http_status: res.statusCode,
    ret_code: parsed.retCode,
    ret_msg: parsed.retMsg,
    result: parsed.result,
    time: parsed.time ?? Date.now(),
    trace: { ...trace, body_snippet: parsed.retCode !== 0 ? text.slice(0, 500) : null },
    label: label ?? null,
    signal_id: signalId ?? null,
  };
  if (idempotencyKey && parsed.retCode === 0) idempotencyCache.set(idempotencyKey, out);
  return reply.send(out);
});

fastify.setErrorHandler((err, req, reply) => {
  req.log.error({ err: err.message }, "unhandled");
  reply.code(500).send({ ok: false, error: "internal", message: err.message });
});

fastify.listen({ port: PORT, host: "0.0.0.0" })
  .then(() => { console.log(JSON.stringify({ evt: "bridge_listening", port: PORT, version: VERSION, bybit_base: BYBIT_BASE, region: REGION })); })
  .catch((e) => { console.error(e); process.exit(1); });
