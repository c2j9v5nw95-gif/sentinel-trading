// bybit-reconcile — periodic drift detection AND active exit recovery.
//
// For each non-paper open position:
//   1. Fetch venue position via client.getPosition(symbol).
//   2. If size=0 -> mark local closed (clears any pending recovery).
//   3. If size mismatch > 1% -> rewrite qty_open, log drift event.
//   4. If venue side differs -> mark closed (catastrophic) + critical alert.
//   5. If venue still open AND exit_recovery_state in ('pending','in_progress')
//      -> attempt bounded reduce-only force-close.
//   6. Emit position_events.reconciliation_ok when in sync.
//
// Recovery rules (safety-critical):
//   - reduceOnly = true ALWAYS. Never opens new exposure.
//   - Symbol lock kind=exit with allowPreempt — preempts entry/protect/reconcile.
//   - Deterministic orderLinkId `RECOV-<position-id-prefix>-<attempt>` so the
//     same attempt is idempotent at Bybit.
//   - Bounded: MAX_RECOVERY_ATTEMPTS, with backoff per attempt (RECOVERY_BACKOFF_MS).
//   - On success: position closed locally, Telegram live_exit reason=recovered.
//   - On final failure: state -> manual_required, critical Telegram unprotected_position.
//
// Cron-friendly: runs every ~60s.

import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { getClient } from "../_shared/bybit-client.ts";
import { withSymbolLock } from "../_shared/locks.ts";
import { notify } from "../_shared/telegram.ts";
import { bridgeConfigured } from "../_shared/bridge-rest.ts";
import type { ExecutionMode } from "../_shared/execution-mode.ts";
import type { BybitClient } from "../_shared/bybit-client.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Build a venue client for recovery use.
 *
 * SAFETY: Recovery is risk-reducing. We deliberately bypass the live execution
 * gate (liveGatePassed=true) because recovery only sends reduce-only orders.
 * For LIVE we FORCE useBridge=true whenever the bridge is configured —
 * regardless of `app_settings.use_execution_bridge` and regardless of whether
 * the bridge health-check is fresh. The bridge call itself may still succeed
 * even when the precheck went stale; trying via bridge is strictly safer than
 * leaving a position open. If bridge is not configured at all, we fall back
 * to the direct path (which requires live API keys via the live client).
 */
function recoveryClient(sb: SupabaseClient, mode: ExecutionMode): BybitClient {
  if (mode !== "live") return getClient(mode, sb);
  return getClient("live", sb, { liveGatePassed: true, useBridge: bridgeConfigured() });
}

const TOLERANCE_PCT = 0.01;
const MAX_RECOVERY_ATTEMPTS = 5;
// Backoff (seconds) keyed by attempt count already made. attempt 0 -> immediate.
const RECOVERY_BACKOFF_SEC = [0, 30, 60, 120, 300];

interface PositionRow {
  id: string;
  symbol: string;
  side: "long" | "short";
  qty_open: number | null;
  execution_mode: ExecutionMode;
  entry_price: number | null;
  opened_at: string | null;
  leverage: number | null;
  exit_recovery_state: string | null;
  exit_recovery_attempts: number | null;
  exit_recovery_last_at: string | null;
}

function shortLink(positionId: string, attempt: number): string {
  return `RECOV-${positionId.slice(0, 8)}-${attempt}`;
}

function backoffElapsed(pos: PositionRow): boolean {
  const attempts = pos.exit_recovery_attempts ?? 0;
  if (!pos.exit_recovery_last_at) return true;
  const waitSec = RECOVERY_BACKOFF_SEC[Math.min(attempts, RECOVERY_BACKOFF_SEC.length - 1)] ?? 300;
  const ageSec = (Date.now() - new Date(pos.exit_recovery_last_at).getTime()) / 1000;
  return ageSec >= waitSec;
}



async function attemptRecovery(
  sb: SupabaseClient, pos: PositionRow, venueSize: number, venueSide: "long" | "short" | "none",
): Promise<"recovered" | "retry" | "manual"> {
  const attempt = (pos.exit_recovery_attempts ?? 0) + 1;
  const linkId = shortLink(pos.id, attempt);

  // Mark in_progress immediately so a concurrent dispatcher won't double-flag.
  await sb.from("positions").update({
    exit_recovery_state: "in_progress",
    exit_recovery_attempts: attempt,
    exit_recovery_last_at: new Date().toISOString(),
  }).eq("id", pos.id);

  await sb.from("position_events").insert({
    position_id: pos.id, event_type: "exit_recovery_attempted",
    detail: { attempt, link_id: linkId, venue_size: venueSize, venue_side: venueSide },
  });
  await sb.from("audit_log").insert({
    action: "exit_recovery_attempted", target: pos.id,
    after: { attempt, link_id: linkId, max_attempts: MAX_RECOVERY_ATTEMPTS },
  });

  // Use the venue size as the source of truth — never the local qty_open.
  const qty = venueSize;
  const submitSide = pos.side === "long" ? "Sell" : "Buy";

  let lastError: string | null = null;
  try {
    const client = pos.execution_mode === "live"
      ? await getClientAsync("live", sb, { liveGatePassed: true })
      : getClient(pos.execution_mode, sb);

    const fill = await client.submitOrder({
      symbol: pos.symbol, side: submitSide, qty,
      reduceOnly: true,                  // SAFETY: never opens new exposure.
      orderLinkId: linkId,                // deterministic per attempt -> idempotent.
      positionId: pos.id, orderType: "Market",
      purpose: "exit_full",
    });

    if (fill.status === "filled") {
      const fillPrice = fill.avgFillPrice ?? Number(pos.entry_price ?? 0);
      // Compute realized PnL.
      let pnl = 0; let pnlPct: number | null = null;
      if (pos.entry_price != null) {
        const dir = pos.side === "long" ? 1 : -1;
        pnl = (fillPrice - Number(pos.entry_price)) * fill.filledQty * dir;
        const notional = Number(pos.entry_price) * fill.filledQty;
        if (notional > 0) pnlPct = (pnl / notional) * 100;
      }

      await sb.from("positions").update({
        qty_open: 0,
        closed_at: new Date().toISOString(),
        protection_state: "closed",
        last_seen_price: fillPrice,
        realized_pnl: pnl,
        exit_recovery_state: "recovered",
        exit_recovery_last_error: null,
      }).eq("id", pos.id);

      await sb.from("position_events").insert({
        position_id: pos.id, event_type: "exit_recovery_succeeded",
        detail: { attempt, fill_price: fillPrice, qty: fill.filledQty, pnl, pnl_pct: pnlPct, link_id: linkId },
      });
      await sb.from("audit_log").insert({
        action: "exit_recovery_succeeded", target: pos.id,
        after: { attempt, fill_price: fillPrice, qty: fill.filledQty, pnl, pnl_pct: pnlPct },
      });

      const openedAt = pos.opened_at ? new Date(pos.opened_at).getTime() : null;
      const holdSec = openedAt ? (Date.now() - openedAt) / 1000 : null;
      if (pos.execution_mode !== "paper") {
        notify({
          severity: "warning",
          category: "live_exit",
          execution_mode: pos.execution_mode,
          symbol: pos.symbol, side: pos.side,
          qty: fill.filledQty,
          entry_price: pos.entry_price != null ? Number(pos.entry_price) : null,
          exit_price: fillPrice,
          pnl, pnl_pct: pnlPct, hold_seconds: holdSec,
          leverage: pos.leverage != null ? Number(pos.leverage) : null,
          reason: `Recovered exit (attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS}) — auto force-close`,
        });
      }
      return "recovered";
    }

    lastError = `unfilled:${fill.status}${fill.message ? ":" + fill.message : ""}`;
  } catch (e) {
    lastError = (e as Error).message?.slice(0, 300) ?? "submit_threw";
  }

  // Failure path.
  await sb.from("positions").update({
    exit_recovery_state: attempt >= MAX_RECOVERY_ATTEMPTS ? "manual_required" : "pending",
    exit_recovery_last_error: lastError,
  }).eq("id", pos.id);

  await sb.from("position_events").insert({
    position_id: pos.id, event_type: "exit_recovery_failed",
    detail: { attempt, error: lastError, link_id: linkId },
  });
  await sb.from("audit_log").insert({
    action: "exit_recovery_failed", target: pos.id,
    after: { attempt, error: lastError, max_attempts: MAX_RECOVERY_ATTEMPTS },
  });
  await sb.from("error_log").insert({
    source: "bybit-reconcile.recovery",
    message: `exit recovery attempt ${attempt} failed for ${pos.symbol}`,
    context: { position_id: pos.id, attempt, link_id: linkId, error: lastError },
  });

  if (attempt >= MAX_RECOVERY_ATTEMPTS) {
    await sb.from("system_alerts").insert({
      severity: "critical", category: "exit_recovery_exhausted",
      message: `Exit recovery exhausted on ${pos.symbol} after ${attempt} attempts — manual close required`,
      context: { position_id: pos.id, last_error: lastError, venue_size: venueSize },
    });
    notify({
      severity: "critical", category: "unprotected_position",
      execution_mode: pos.execution_mode, symbol: pos.symbol, side: pos.side,
      reason: `Exit recovery EXHAUSTED after ${attempt} attempts — close manually on Bybit`,
      extra: { position_id: pos.id, last_error: lastError, venue_size: venueSize },
    });
    return "manual";
  }

  // Soft warning per attempt — operator can see retries pile up.
  notify({
    severity: "warning", category: "unprotected_position",
    execution_mode: pos.execution_mode, symbol: pos.symbol, side: pos.side,
    reason: `Exit recovery attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS} failed: ${lastError}`,
    extra: { position_id: pos.id, venue_size: venueSize },
  });
  return "retry";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const sb = serviceClient();
  const summary = { reconciled: 0, drift: 0, closed: 0, errors: 0, recovered: 0, recovery_retried: 0, recovery_manual: 0 };

  const { data: positions } = await sb.from("positions")
    .select("id,symbol,side,qty_open,execution_mode,entry_price,opened_at,leverage,exit_recovery_state,exit_recovery_attempts,exit_recovery_last_at")
    .is("closed_at", null)
    .in("execution_mode", ["testnet", "live"]);

  for (const raw of positions ?? []) {
    const p = raw as PositionRow;
    try {
      const lockResult = await withSymbolLock(sb, p.symbol, "exit",
        { ttlSec: 30, allowPreempt: true },
        async () => {
          const client = p.execution_mode === "live"
            ? await getClientAsync("live", sb, { liveGatePassed: true })
            : getClient(p.execution_mode as ExecutionMode, sb);
          const venue = await client.getPosition(p.symbol);
          const localQty = Number(p.qty_open ?? 0);

          // Venue flat -> reconcile only, clear any pending recovery.
          if (venue.size <= 0) {
            await sb.from("positions").update({
              qty_open: 0, closed_at: new Date().toISOString(),
              protection_state: "closed",
              exit_recovery_state: p.exit_recovery_state ? "recovered" : null,
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
              qty_open: 0, closed_at: new Date().toISOString(),
              protection_state: "closed",
              exit_recovery_state: "manual_required",
              exit_recovery_last_error: `venue_side_mismatch:local=${p.side},venue=${venue.side}`,
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

          // Recovery branch — venue still open AND we've been asked to flatten.
          if (p.exit_recovery_state === "pending" || p.exit_recovery_state === "in_progress") {
            if (!backoffElapsed(p)) return { ok: true, skipped: "backoff" };
            const out = await attemptRecovery(sb, p, venue.size, venue.side);
            if (out === "recovered") summary.recovered++;
            else if (out === "manual") summary.recovery_manual++;
            else summary.recovery_retried++;
            return { ok: true };
          }

          // Standard drift handling.
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

      if (!lockResult.ok && lockResult.reason === "symbol_busy") {
        // Another exit in flight — skip this round, we'll catch it next cron.
        continue;
      }
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
