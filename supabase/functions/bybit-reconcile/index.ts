// bybit-reconcile — periodic drift detection between local DB and Bybit testnet/live.
//
// For each non-paper open position:
//   1. Fetch venue position via client.getPosition(symbol).
//   2. If size=0 -> mark local closed + emit reconciliation_drift event.
//   3. If size mismatch > 1% -> rewrite qty_open, log drift event.
//   4. If venue side differs -> mark closed (catastrophic drift) + critical alert.
//   5. Emit position_events.reconciliation_ok when in sync.
//
// Operates under a per-symbol lock kind=reconcile (preempted by exit).
// Cron-friendly: runs every ~60s.

import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { getClient } from "../_shared/bybit-client.ts";
import { withSymbolLock } from "../_shared/locks.ts";
import type { ExecutionMode } from "../_shared/execution-mode.ts";

const TOLERANCE_PCT = 0.01;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const sb = serviceClient();
  const summary = { reconciled: 0, drift: 0, closed: 0, errors: 0 };

  const { data: positions } = await sb.from("positions")
    .select("id,symbol,side,qty_open,execution_mode,entry_price")
    .is("closed_at", null)
    .in("execution_mode", ["testnet", "live"]);

  for (const p of positions ?? []) {
    try {
      await withSymbolLock(sb, p.symbol, "reconcile",
        { ttlSec: 30 },
        async () => {
          const client = getClient(p.execution_mode as ExecutionMode, sb);
          const venue = await client.getPosition(p.symbol);
          const localQty = Number(p.qty_open ?? 0);

          if (venue.size <= 0) {
            await sb.from("positions").update({
              qty_open: 0, closed_at: new Date().toISOString(), protection_state: "closed",
            }).eq("id", p.id);
            await sb.from("position_events").insert({
              position_id: p.id, event_type: "reconciliation_drift",
              detail: { reason: "venue_flat", local_qty: localQty },
            });
            summary.closed++;
            return { ok: true };
          }

          if (venue.side !== p.side) {
            await sb.from("positions").update({
              qty_open: 0, closed_at: new Date().toISOString(), protection_state: "closed",
            }).eq("id", p.id);
            await sb.from("system_alerts").insert({
              severity: "critical", category: "reconciliation_drift",
              message: `Venue side mismatch on ${p.symbol}: local=${p.side} venue=${venue.side}`,
              context: { position_id: p.id, local_side: p.side, venue_side: venue.side },
            });
            await sb.from("position_events").insert({
              position_id: p.id, event_type: "reconciliation_drift",
              detail: { reason: "side_mismatch", local_side: p.side, venue_side: venue.side },
            });
            summary.drift++;
            return { ok: true };
          }

          const diff = Math.abs(venue.size - localQty);
          const tol = Math.max(localQty * TOLERANCE_PCT, 1e-8);
          if (diff > tol) {
            await sb.from("positions").update({ qty_open: venue.size }).eq("id", p.id);
            await sb.from("position_events").insert({
              position_id: p.id, event_type: "reconciliation_drift",
              detail: { reason: "qty_mismatch", local_qty: localQty, venue_qty: venue.size },
            });
            summary.drift++;
          } else {
            await sb.from("position_events").insert({
              position_id: p.id, event_type: "reconciliation_ok",
              detail: { qty: venue.size },
            });
            summary.reconciled++;
          }
          return { ok: true };
        });
    } catch (e) {
      summary.errors++;
      await sb.from("error_log").insert({
        source: "bybit-reconcile", message: (e as Error).message,
        context: { position_id: p.id, symbol: p.symbol },
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, ...summary }), {
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
});
