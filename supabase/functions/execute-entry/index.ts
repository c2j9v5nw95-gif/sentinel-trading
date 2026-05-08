// execute-entry — Phase 3.
//
// Per-symbol sizing model:
//   margin_alloc   = available_balance * (account_balance_percent / 100)
//   exposure (USDT) = margin_alloc * leverage * position_size_multiplier
//   est_qty        = exposure / mark_price  (rounded to symbol step)
//
// Hard safety caps (per symbol, optional):
//   max_position_notional_usdt — exposure cap
//   max_margin_usage_usdt     — margin cap
// These caps are enforced BEFORE leverage is applied or any order is placed.
// If exceeded the entry is REJECTED (never silently shrunk):
//   - insert risk_decisions row (gate=exposure_limit, outcome=block)
//   - mark signal status=rejected with decision_reason
//   - write audit_log entry action=entry_rejected_exposure_cap
//   - return without touching Bybit
//
// Both `available_balance` and current Bybit position state MUST be fetched
// fresh from Bybit V5 — never reuse cached frontend values.
//
// Order of operations:
//   1. Fetch fresh wallet balance + ticker + symbol info (max leverage).
//   2. validateSymbolSizing — abort on invalid config.
//   3. computeEntrySizing(...) — produces breakdown including cap evaluation.
//   4. If exposureCapExceeded || marginCapExceeded: log + reject, stop here.
//   5. Apply leverage on Bybit (set-leverage) — clamp to symbol max.
//   6. Place market entry (BybitClient.placeMarketOrder).
//   7. Immediately attach fixed SL (BybitClient.setStopLoss).
//      If SL placement fails after retries: mark UNPROTECTED + critical alert
//      + entries_paused = true.
//   8. Persist `orders` row with full sizing breakdown in request_payload
//      and an audit_log entry mirroring the breakdown.
import { corsHeaders } from "../_shared/db.ts";
import { computeEntrySizing, validateSymbolSizing } from "../_shared/sizing.ts";

// Re-export so the surface is discoverable from process-signal in Phase 2.
export { computeEntrySizing, validateSymbolSizing };

Deno.serve(async (_req) =>
  new Response(JSON.stringify({ todo: "phase 3" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  }),
);
