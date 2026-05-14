## Goal

Eliminate the "Failed to load live wallet" 403 and ensure all live wallet/balance reads go through the execution bridge (never direct from Supabase). No execution / order / sizing logic touched.

## Root cause recap

- `op-live-wallet` correctly uses the bridge, but its first call is `GET /v5/account/info`, which is **not on the bridge allowlist** → bridge returns 403 `endpoint_not_whitelisted` → whole function fails before it ever reaches the wallet-balance call.
- `analytics-snapshot-balances` uses `BybitRest` **directly** (`https://api.bybit.com`) for live mode → Bybit returns `retCode 10010` (Supabase egress IP not whitelisted on the live key).

## Changes

### 1. `supabase/functions/op-live-wallet/index.ts`

- Remove the `/v5/account/info` call entirely (lines ~55–60).
- Set `account_mode` from the wallet-balance response instead: derive from `acct.accountType` (e.g. `"UNIFIED"` → `"unified"`, `"CONTRACT"` → `"contract"`); fall back to `"unknown"`.
- Keep the existing UNIFIED-then-CONTRACT wallet-balance fallback exactly as is.
- Keep the bridge-preferred / direct-fallback selection exactly as is.
- No other behavior changes; response shape stays identical (`account_mode` field still populated).

### 2. `supabase/functions/analytics-snapshot-balances/index.ts`

- In `snapshotLive()` (lines ~62–94): replace the direct `new BybitRest({...api.bybit.com...})` with the same bridge-preferred pattern used in `op-live-wallet`:
  - `bridgeConfigured() ? new BridgeBybitRest({ bridgeUrl, bridgeSecret, label: "analytics-snapshot-balances" }) : new BybitRest({...})`
  - Add `import { BridgeBybitRest, bridgeConfigured } from "../_shared/bridge-rest.ts";`
- Remove the `/v5/account/info` call here too (same reason — not allowlisted, and `accountMode` can come from wallet-balance result or be left `"unknown"` since this is a snapshot writer, not a UI field).
- Keep UNIFIED→CONTRACT fallback unchanged. Keep paper path untouched.

### 3. Audit — confirmed no other callers need changes

`rg` shows only three places hit `/v5/account/wallet-balance` or `/v5/account/info`:
- `op-live-wallet` ✓ fixed above
- `analytics-snapshot-balances` ✓ fixed above
- `_shared/venue-client.ts` — already uses `BridgeBybitRest` when `mode === "live"` and bridge is configured (line 51). No change needed.

`op-bridge-smoke` and `op-test-bybit-connection` are diagnostic tools and out of scope.

## Out of scope (per Core memory and your instructions)

- No changes to executor, sizing, dispatcher, bridge routing logic, locks, risk engine, reconcile, or order submit paths.
- Not adding `/v5/account/info` to the bridge allowlist (bridge config is yours; we simply stop calling that endpoint).
- Not touching the Bybit live key IP whitelist (that's an exchange-side setting; bridge routing makes it unnecessary).

## Verification

1. Deploy `op-live-wallet` and `analytics-snapshot-balances`.
2. Reload `/settings` (or wherever the live wallet card renders) — expect 200 with populated `total_equity`, `available_balance`, etc.
3. Tail `op-live-wallet` logs — expect `bridge_request` for `/v5/account/wallet-balance` with `http_status: 200` and `ret_code: 0`. No more `endpoint_not_whitelisted`.
4. Trigger `analytics-snapshot-balances` and confirm bridge transport in logs (no more `Unmatched IP` `retCode 10010`).

## Risk

Very low — read-only endpoints, response shape preserved, bridge path already proven by `venue-client.ts`. If `account_mode` precision matters for the Settings UI, we can add it back via a separate allowlisted call later.
