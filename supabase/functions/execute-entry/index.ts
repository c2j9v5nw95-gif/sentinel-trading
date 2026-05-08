// execute-entry — Phase 3.
//
// Per-symbol sizing model:
//   margin_alloc   = available_balance * (account_balance_percent / 100)
//   exposure (USDT) = margin_alloc * leverage * position_size_multiplier
//   est_qty        = exposure / mark_price  (rounded to symbol step)
//
// Both `available_balance` and current Bybit position state MUST be fetched
// fresh from Bybit V5 — never reuse cached frontend values.
//
// Order of operations:
//   1. Fetch fresh wallet balance + ticker + symbol info (max leverage).
//   2. Validate per-symbol sizing fields (validateSymbolSizing).
//   3. Apply leverage on Bybit (set-leverage) — clamp to symbol max.
//   4. computeEntrySizing(...) → estimatedQty.
//   5. Place market entry (BybitClient.placeMarketOrder).
//   6. Immediately attach fixed SL (BybitClient.setStopLoss).
//      If SL placement fails after retries: mark UNPROTECTED + critical alert
//      + entries_paused = true.
//   7. Persist `orders` row with full sizing breakdown in request_payload
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
