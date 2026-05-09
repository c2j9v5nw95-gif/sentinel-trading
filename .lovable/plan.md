## Goal

Stop chasing endpoints. Pin live execution to `api.bybit.com` and add deterministic, side-by-side request/response tracing so the next failure isolates the root cause to one of: runtime/IP block, malformed request, signing mismatch, payload shape, account-mode mismatch, or regional Bybit protection.

## Step 1 — Revert base URL

- Update the `BYBIT_API_BASE_URL` secret to `https://api.bybit.com` (operator action via secrets tool — I'll prompt for confirmation before changing).
- No code change needed; `liveBaseUrlInfo()` already prefers env and falls back to the official mainnet default. Once the secret matches the default, the gate treats it as `is_alternate=false` and skips the alternate-base diagnostic gate automatically.
- Add a one-line operator banner in `BybitDiagnosticsPanel` confirming "Active base URL = official mainnet, alternate-base gate inactive".

## Step 2 — Single shared Bybit transport (no behavioral drift)

Both diagnostics and executor already go through `BybitRest`. Lock parity by:

- Making `getPosition(symbol)` in `venue-client.ts` and the diagnostics `read_positions_by_symbol` call use a single shared helper `buildPositionListRequest({ symbol })` so query keys/order/casing cannot drift.
- Same treatment for the order-create reachability probe (`buildOrderCreateProbe()` → used by diagnostics; executor calls it with real qty/side).
- Add a unit-style assert at handler boot that the helpers produce the expected canonical query strings.

## Step 3 — Full redacted request/response trace

Extend `bybit-rest.ts` so EVERY call (not just transport errors) writes a single structured `bybit_trace` log line on completion containing:

Request side (already partially logged):
- `label`, `attempt`, `base_url`, `endpoint`, `method`
- `query` (object) + `query_string` (exact serialized form used for signing)
- `body_keys`, `body_size`, `body_sha256_prefix` (first 8 hex chars — proves body parity without leaking)
- `recv_window_ms`, `timestamp_ms`
- `sign_payload_prefix` (`ts+key+recv+...` first 32 chars, redacting key to prefix only)
- `sign_len`, `api_key_prefix`
- `idempotency_key`

Response side (new):
- `http_status`, `content_type`, `content_length`
- `cf_ray`, `server`, `x-bapi-request-id`, `x-amz-cf-id`, `x-amz-cf-pop`, `via`
- `ret_code`, `ret_msg` when JSON
- `body_snippet` (first 500 chars) — always on non-2xx, on transport error, OR when env `BYBIT_TRACE_BODY=1`
- `duration_ms`

Failure-fast rules:
- Drop the existing one-shot retry on 5xx/429 for `/v5/position/list` and `/v5/order/create` while we audit (`MAX_ATTEMPTS=1` for these two endpoints behind a `BYBIT_AUDIT_MODE=1` flag). Other endpoints keep current behavior.
- `BybitTransportError` keeps full diagnostics; gate already surfaces it. No silent retries.

## Step 4 — Diagnostics surfaces the same trace

`op-test-bybit-connection` already mirrors the executor `getPosition` shape (`read_positions_by_symbol`). Extend it to also persist the new response-side fields (cf_ray, server, x-bapi-request-id, body_sha256_prefix, sign_payload_prefix) into `checks._meta.detail`, so a single SQL query can diff a passing diagnostic vs the failing executor request line-by-line.

## Step 5 — Audit UI on /signals

When a signal fails with `bybit_transport_forbidden`, the existing Live Gate Debug Panel gains a "Transport Audit" card that shows, side by side:

| field | last passing diagnostic | failing executor call |
| --- | --- | --- |
| base_url, endpoint, query_string | ✓ | ✗ |
| sign_payload_prefix, body_sha256_prefix | ✓ | ✗ |
| http_status, server, cf_ray, x-bapi-request-id | ✓ | ✗ |
| body_snippet | ✓ | ✗ |

Data source: read latest `bybit_diagnostics` row for the symbol, plus the matching `bybit_trace` log line for the failed signal (looked up by `signal_id` in edge logs via existing logs query path, or persisted into a new `bybit_request_traces` table — see Decision below).

## Step 6 — Replay & verify

Once deployed:
1. Confirm secret = `https://api.bybit.com`, gate logs `is_alternate=false`.
2. Run live diagnostics for PENGUUSDT (will include trace fields).
3. Replay one PENGUUSDT signal.
4. Inspect the audit card — three outcomes determine the diagnosis:
   - Same query/sign/body fingerprints, same headers, same 200 response → bug elsewhere.
   - Same fingerprints, executor gets 403/CloudFront body → **runtime/IP block** specific to that worker invocation.
   - Different fingerprints → **request shape / signing drift** (helper not actually shared).
   - 200 on `/v5/position/list` but 403/error on `/v5/order/create` → **account-mode / order payload** issue, not transport.

## Decision needed before I implement

I want one answer before starting:

**Where to store the trace for the audit UI?**
1. **Edge function logs only** (parse via existing `edge_function_logs` query keyed by `signal_id`). No schema change. Slightly slower UI, log retention is bounded.
2. **New `bybit_request_traces` table** (insert one row per Bybit call with the redacted trace). Persistent, queryable, easier UI, costs ~1 insert per Bybit request.

I recommend **option 2** for executor calls only (skip table writes for paper/testnet) so the audit survives log retention and the UI is a simple SQL query.

## Out of scope (intentionally)

- No further endpoint switching.
- No retry-policy changes outside the two audited endpoints.
- No changes to signing algorithm or auth headers — we are verifying parity, not rewriting.

## Technical detail (for reviewers)

Files touched:
- `supabase/functions/_shared/bybit-rest.ts` — trace logging, audit-mode no-retry, sha256 prefix helper.
- `supabase/functions/_shared/venue-client.ts` — use shared `buildPositionListRequest` / `buildOrderCreateProbe`.
- `supabase/functions/_shared/bybit-requests.ts` (new) — canonical request builders + boot-time assertions.
- `supabase/functions/op-test-bybit-connection/index.ts` — persist response-side trace fields under `checks._meta.detail`.
- `supabase/functions/_shared/live-client.ts` — already auto-detects default base; only banner-state hint added.
- `src/components/BybitDiagnosticsPanel.tsx` + `src/routes/_app.signals.tsx` — Transport Audit card.
- (If option 2 chosen) migration: `bybit_request_traces` table + RLS (operator read).

Secrets: update `BYBIT_API_BASE_URL` → `https://api.bybit.com`. Optional new env: `BYBIT_AUDIT_MODE=1`, `BYBIT_TRACE_BODY=1`.
