# Execution Bridge Architecture

## Problem (recap)

Supabase/Lovable Edge runtime egress lands on a CloudFront POP that Bybit's WAF returns `403 The Amazon CloudFront distribution is configured to block access from your country` for. Diagnostics from a different POP succeed; signing, payload, and request parity are confirmed identical. Endpoint hopping (`api.bybit.com` ↔ `api.bytick.com`) is not solving it. We move execution off the edge runtime onto a fixed-IP VPS that is whitelisted in the Bybit API key.

## Target topology

```text
TradingView ──▶ Supabase (ingest-webhook)
                  │
                  ├─ dedupe / parser / risk engine / health gate / live gate
                  ├─ audit_log, error_log, signals, bybit_request_traces
                  ├─ Telegram, diagnostics, state machine
                  │
                  ▼
            Execution Bridge (VPS, fixed public IP, Bybit-supported region)
                  │  HTTPS + HMAC-signed, replay-protected, idempotent
                  ▼
              Bybit V5 REST  (api.bybit.com)
```

Supabase keeps everything except the actual signed Bybit call. The bridge is a thin signed-passthrough that owns the Bybit API key/secret and is the only thing whose egress IP Bybit sees.

## Bridge service (Node 20 + Fastify, deployed to a VPS)

Single small service, shipped from this repo under `bridge/`. Endpoints:

- `POST /v1/bybit/position/list` → calls Bybit `/v5/position/list`
- `POST /v1/bybit/order/create`  → calls Bybit `/v5/order/create`
- `POST /v1/bybit/order/cancel`  → `/v5/order/cancel`
- `POST /v1/bybit/position/set-trading-stop` → `/v5/position/trading-stop`
- `GET  /v1/health`              → `{ ok, version, bybit_reachable, public_ip, region, uptime_s }`
- `GET  /v1/diag`                → runs canonical diagnostic against Bybit, returns same shape as `bybit-diagnostics`

Bridge owns:
- `BYBIT_LIVE_API_KEY`, `BYBIT_LIVE_API_SECRET` (moved off Supabase secrets in a follow-up; for the cutover both sides hold them)
- canonical V5 signer (lifted from `_shared/bybit-rest.ts` so byte-for-byte identical signing)
- `recvWindow=5000`, idempotency on `orderLinkId`, in-memory LRU dedupe (5 min) keyed by `orderLinkId` so retries return the original response
- structured JSON: `{ ok, http_status, ret_code, ret_msg, result, trace: { cf_ray, server, amz_cf_pop, request_id, body_snippet, duration_ms } }`
- fail-fast: no internal retry loops; one attempt, surface real error

## Bridge ↔ Supabase auth

Shared secret `EXECUTION_BRIDGE_SECRET` (added to both sides). Every Supabase→bridge request carries:

- `X-Bridge-Timestamp`: ms epoch (reject if `|now - ts| > 30s`)
- `X-Bridge-Nonce`: uuid (replay cache 5 min)
- `X-Bridge-Signature`: `hex(hmac_sha256(secret, ts + "." + nonce + "." + method + "." + path + "." + sha256(body)))`
- `X-Idempotency-Key`: `orderLinkId` for order-mutating calls

Bridge: HTTPS only (Caddy or Cloudflare proxy in front for TLS), `Strict-Transport-Security`, no CORS, IP-allowlist optional.

## Supabase side changes

- New secrets: `EXECUTION_BRIDGE_URL`, `EXECUTION_BRIDGE_SECRET`
- New `_shared/bridge-client.ts`: thin signed-fetch helper. Handles signing, 30s timeout, fail-fast, persists trace into `bybit_request_traces` (label `bridge:<endpoint>`)
- Replace direct Bybit calls in `_shared/bybit-rest.ts` callsites used by `_shared/executor.ts` and `_shared/venue-client.ts` for **live** mode with bridge calls. Diagnostics keeps the existing direct path so we can keep comparing.
- `BYBIT_AUDIT_MODE` retired in code paths that now go through the bridge (kept env var to not break secret list).
- New `op-bridge-health` edge function: pings bridge `/v1/health`, persists into a new `bridge_health_checks` table, raises `system_alerts(severity=critical, category=bridge_unreachable)` after 2 consecutive failures, also wired into `notify()` (Telegram).
- `live-gate` (`live-client.ts`) gains a precheck: bridge must be `ok` within last 60s, else block signal with reason `bridge_unreachable` (fail signals fast — no Bybit attempt).
- New table `bridge_health_checks(id, checked_at, ok, latency_ms, public_ip, bybit_reachable, http_status, error)`; RLS operator-read; insert from edge function via service role.

## UI

- New `BridgeStatusPanel` on Kontrollsenter: last health check, latency, bridge public IP, Bybit reachable, last 20 checks sparkline, manual "Run health check" button that invokes `op-bridge-health`.
- Add bridge trace rows to existing `BybitDiagnosticsPanel` (filter by `label LIKE 'bridge:%'`).

## Operational

- Bridge logs structured JSON to stdout; ship via journald.
- README in `bridge/README.md` covering: VPS sizing (1 vCPU / 1GB is enough), supported regions (AWS Tokyo / GCP asia-northeast1 / Hetzner Helsinki — pick one Bybit allows; user to confirm region), `systemd` unit, Caddy TLS config, how to whitelist the VPS public IP in the Bybit API key page, secret rotation, and a `curl` smoke test.
- Cutover: deploy bridge, whitelist IP, set `EXECUTION_BRIDGE_URL` + `EXECUTION_BRIDGE_SECRET`, flip a new `app_settings.use_execution_bridge` boolean (default true). If bridge fails health gate, signals fail fast; reverting the flag falls back to direct edge-runtime calls.

## Out of scope this round

- Multi-bridge HA / round-robin
- Moving paper/testnet through the bridge (stays direct)
- Migrating existing Bybit secrets off Supabase (kept dual until bridge is proven)

## Open questions for you

1. Do you already have a VPS / preferred provider + region (AWS Tokyo, GCP asia-northeast1, Hetzner Helsinki, your own)? This determines the IP we whitelist.
2. OK with Caddy auto-TLS on a subdomain you own (e.g. `bridge.yourdomain.com`), or do you want Cloudflare in front?
3. Do you want me to land **only the Supabase-side bridge client + health gate + UI + flag** in this turn (so the moment you stand up the VPS it works), or also commit the `bridge/` Node service code now so you can `scp` and `systemctl start` it?

Confirm those three and I'll implement.
