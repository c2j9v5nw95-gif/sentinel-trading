// protection-monitor — cron, runs every ~15s.
//
// For every open position (per execution_mode):
//   1. Pull latest paper_market_prices.price (live mode: would call Bybit ticker).
//   2. Update last_seen_price.
//   3. SL hit? -> issue reduce-only market exit via the matching client (full close).
//   4. TSL not active and unrealized profit >= tsl_activation_profit_pct? -> activate.
//   5. TSL active? -> recompute high-water + trigger price; if price crosses
//      trigger, exit full.
//   6. Drift check: if local qty_open > 0 but client.getPosition reports size=0
//      -> mark closed + alert.
//
// All writes go through symbol locks of kind=protect (preempted only by exits).

import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { getClient } from "../_shared/bybit-client.ts";
import { withSymbolLock } from "../_shared/locks.ts";
import { notify } from "../_shared/telegram.ts";
import type { ExecutionMode } from "../_shared/execution-mode.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

interface PositionRow {
  id: string; symbol: string; side: "long" | "short";
  execution_mode: ExecutionMode;
  qty_open: number | null; entry_price: number | null;
  sl_price: number | null;
  tsl_active: boolean; tsl_activated_at: string | null;
  tsl_high_water_price: number | null; tsl_trigger_price: number | null;
  protection_state: string;
}

function linkId(p: string) { return `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`; }

async function getPaperPrice(sb: SupabaseClient, symbol: string): Promise<number | null> {
  const { data } = await sb.from("paper_market_prices")
    .select("price,received_at").eq("symbol", symbol).maybeSingle();
  if (!data) return null;
  const ageMs = Date.now() - new Date(data.received_at).getTime();
  if (ageMs > 5 * 60_000) return null;
  return Number(data.price);
}

async function logEvent(sb: SupabaseClient, posId: string, type: string, detail: unknown) {
  await sb.from("position_events").insert({ position_id: posId, event_type: type, detail });
}

async function closeAtMarket(
  sb: SupabaseClient, pos: PositionRow, price: number, reason: string,
): Promise<void> {
  const client = getClient(pos.execution_mode, sb);
  const submitSide = pos.side === "long" ? "Sell" : "Buy";
  const fill = await client.submitOrder({
    symbol: pos.symbol, side: submitSide, qty: Number(pos.qty_open),
    reduceOnly: true, orderLinkId: linkId(`P-${reason}`),
    positionId: pos.id, orderType: "Market", price,
    purpose: reason === "sl" ? "sl" : reason === "tsl" ? "tsl" : "exit_full",
  });
  if (fill.status !== "filled") {
    await logEvent(sb, pos.id, "protection_exit_failed", { reason, fill });
    await sb.from("system_alerts").insert({
      severity: "critical", category: "protection_exit_failed",
      message: `${reason.toUpperCase()} exit failed for ${pos.symbol}`,
      context: { position_id: pos.id, fill },
    });
    return;
  }

  const fillPrice = fill.avgFillPrice ?? price;
  if (pos.execution_mode === "paper" && pos.entry_price != null) {
    const dir = pos.side === "long" ? 1 : -1;
    const pnl = (fillPrice - Number(pos.entry_price)) * fill.filledQty * dir;
    const { data: w } = await sb.from("paper_wallet").select("*").maybeSingle();
    if (w) {
      await sb.from("paper_wallet").update({
        balance_usdt: Number(w.balance_usdt) + pnl,
        equity_usdt: Number(w.equity_usdt) + pnl,
        realized_pnl: Number(w.realized_pnl) + pnl,
        updated_at: new Date().toISOString(),
      }).eq("id", w.id);
    }
  }

  await sb.from("positions").update({
    qty_open: 0, closed_at: new Date().toISOString(),
    protection_state: "closed", last_seen_price: fillPrice,
  }).eq("id", pos.id);
  await logEvent(sb, pos.id, `${reason}_triggered`, { fill_price: fillPrice });
}

async function processPosition(sb: SupabaseClient, pos: PositionRow): Promise<string> {
  const price = await getPaperPrice(sb, pos.symbol);
  if (price == null || !(Number(pos.qty_open) > 0)) return "no_price_or_closed";

  const client = getClient(pos.execution_mode, sb);
  const live = await client.getPosition(pos.symbol);

  // Drift: local thinks open but venue says flat.
  if (live.size <= 0) {
    await sb.from("positions").update({
      qty_open: 0, closed_at: new Date().toISOString(),
      protection_state: "closed", last_seen_price: price,
    }).eq("id", pos.id);
    await sb.from("system_alerts").insert({
      severity: "warning", category: "position_drift",
      message: `Local position ${pos.symbol} reconciled to flat`,
      context: { position_id: pos.id },
    });
    await logEvent(sb, pos.id, "reconciled_flat", { live });
    return "drift_flat";
  }

  await sb.from("positions").update({ last_seen_price: price }).eq("id", pos.id);

  // SL hit (failsafe — the venue would normally fire this; for paper it's us).
  if (pos.sl_price != null) {
    const slHit = pos.side === "long" ? price <= Number(pos.sl_price) : price >= Number(pos.sl_price);
    if (slHit) { await closeAtMarket(sb, pos, price, "sl"); return "sl_hit"; }
  }

  // Symbol config for TSL.
  const { data: sym } = await sb.from("symbols").select("*").eq("symbol", pos.symbol).maybeSingle();
  if (!sym?.tsl_enabled || pos.entry_price == null) return "no_tsl";

  const entry = Number(pos.entry_price);
  const dir = pos.side === "long" ? 1 : -1;
  const profitPct = ((price - entry) / entry) * 100 * dir;
  const activatePct = Number(sym.tsl_activation_profit_pct ?? 1.0);
  const callbackPct = Number(sym.tsl_callback_pct ?? 0.5) / 100;

  // Activate TSL.
  if (!pos.tsl_active && profitPct >= activatePct) {
    const trigger = pos.side === "long" ? price * (1 - callbackPct) : price * (1 + callbackPct);
    await client.setTradingStop({
      symbol: pos.symbol, positionId: pos.id, tslCallbackPct: callbackPct * 100,
    });
    await sb.from("positions").update({
      tsl_active: true, tsl_activated_at: new Date().toISOString(),
      tsl_high_water_price: price, tsl_trigger_price: trigger,
      tsl_order_id: linkId("TSL"),
      protection_state: "sl_and_tsl",
    }).eq("id", pos.id);
    await logEvent(sb, pos.id, "tsl_activated", { price, trigger, callbackPct });
    return "tsl_activated";
  }

  if (pos.tsl_active) {
    // Move trigger if new high-water established.
    const hw = Number(pos.tsl_high_water_price ?? entry);
    const better = pos.side === "long" ? price > hw : price < hw;
    if (better) {
      const trigger = pos.side === "long" ? price * (1 - callbackPct) : price * (1 + callbackPct);
      await sb.from("positions").update({
        tsl_high_water_price: price, tsl_trigger_price: trigger,
      }).eq("id", pos.id);
      await logEvent(sb, pos.id, "tsl_moved", { price, trigger });
    }
    // Trigger hit?
    const trig = Number(pos.tsl_trigger_price ?? 0);
    const hit = pos.side === "long" ? price <= trig : price >= trig;
    if (hit && trig > 0) { await closeAtMarket(sb, pos, price, "tsl"); return "tsl_hit"; }
  }

  return "ok";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const sb = serviceClient();

  const { data: positions, error } = await sb.from("positions").select(
    "id,symbol,side,execution_mode,qty_open,entry_price,sl_price,tsl_active," +
    "tsl_activated_at,tsl_high_water_price,tsl_trigger_price,protection_state",
  ).is("closed_at", null);
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const results: Array<{ symbol: string; outcome: string }> = [];
  for (const p of (positions ?? []) as PositionRow[]) {
    try {
      const r = await withSymbolLock(sb, p.symbol, "protect", { ttlSec: 20 }, async () => {
        return await processPosition(sb, p);
      });
      results.push({
        symbol: p.symbol,
        outcome: r.ok ? r.value : `lock_${r.reason}`,
      });
    } catch (e) {
      results.push({ symbol: p.symbol, outcome: `error:${(e as Error).message}` });
      await sb.from("error_log").insert({
        source: "protection-monitor", message: (e as Error).message,
        stack: (e as Error).stack ?? null, context: { position_id: p.id, symbol: p.symbol },
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: results.length, results }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
