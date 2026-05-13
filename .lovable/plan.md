## Root cause

`bridge/src/server.js` defines `ALLOWED_ENDPOINTS` with only signed trading/account endpoints:

```
/v5/position/list, /v5/order/create, /v5/order/cancel,
/v5/execution/list, /v5/position/set-leverage,
/v5/position/trading-stop, /v5/account/wallet-balance
```

When the analytics helper (`src/lib/analytics/bybit-public-kline.ts`) POSTs to `/v1/bybit-call` with `endpoint: "/v5/market/kline"`, the bridge rejects it with HTTP 403 `endpoint_not_whitelisted`. The Worker-side fetcher surfaces this as `bridge_http_403` / `error_kind: bridge_http_403`. Same failure would occur for `/v5/market/tickers`.

Note: the analytics helper is already correctly using the shared `/v1/bybit-call` route with bridge HMAC signing — no change needed on the client side. The fix is purely on the bridge allowlist.

## Plan (bridge-only change)

### 1. Extend `ALLOWED_ENDPOINTS` in `bridge/src/server.js`

Add the two public market endpoints to the existing set:

```js
const ALLOWED_ENDPOINTS = new Set([
  // existing signed trading endpoints — unchanged
  "/v5/position/list",
  "/v5/order/create",
  "/v5/order/cancel",
  "/v5/execution/list",
  "/v5/position/set-leverage",
  "/v5/position/trading-stop",
  "/v5/account/wallet-balance",
  // analytics — public GET market data only
  "/v5/market/kline",
  "/v5/market/tickers",
]);
```

No other bridge logic changes. Signing still happens for these calls (Bybit ignores signing for public endpoints, so this is harmless), and the existing `method` check (`GET`/`POST`) plus the analytics caller forcing `method: "GET"` keeps these endpoints read-only.

Explicitly **not** added: any `/v5/order/*` (other than already-allowed), `/v5/position/*` (other than already-allowed), `/v5/account/*` (other than wallet-balance), `/v5/asset/*`, `/v5/user/*`, `/v5/spot/*` trading routes. Allowlist remains the single source of truth.

### 2. Deploy the bridge

The bridge runs on the fixed-IP VPS — it is not auto-deployed by Lovable. After the code change is merged, the user (or ops) must restart the bridge process on the VPS so the new allowlist takes effect. Plan should call this out as a manual step.

### 3. Validation (manual, no code change)

After bridge restart, on `/analytics-debug`:

1. Run **snapshot-regime-tick** with `schedule: "trade"` and `dry_run: true`.
   - Expect: `ok: true`, `api_calls > 0`, `errors: []`, `rows_written: 0`.
2. Run the same with `dry_run: false`.
   - Expect: `rows_written > 0`, new rows in `regime_snapshots`, a closed entry in `analytics_snapshot_runs`.
3. Run **snapshot-signal-context** for one recent trade signal.
   - Expect: rows in `signal_context_snapshots` for the trade-TF and mapped context-TFs.

If 403 still appears, confirm:
- Bridge process actually restarted (check `/v1/health` `version`/uptime).
- `EXECUTION_BRIDGE_URL` / `EXECUTION_BRIDGE_SECRET` env vars are set in the Lovable Cloud server runtime.

## Out of scope (explicitly unchanged)

- No changes to dispatcher, executor, live-client, paper-client, testnet-client, risk-engine, sizing, reconcile, recovery, locks, trail, bybit-rest, bybit-requests, bridge-rest signing.
- No changes to `signals`, `orders`, `positions`, `paper_wallet` schemas.
- No changes to `src/lib/analytics/*` (already uses correct route + signing).
- No new triggers, no cron activation. Phase 2B/2C remain deferred.
- No expansion of allowlist beyond the two named public market endpoints.

## Files touched

- `bridge/src/server.js` — add two entries to `ALLOWED_ENDPOINTS`.

That's the entire code delta. Everything else is restart + validation.
