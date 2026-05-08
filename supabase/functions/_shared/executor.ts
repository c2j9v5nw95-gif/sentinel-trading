// executor — Phase 3 execution lifecycle.
//
// Lives between the dispatcher (gates) and the BybitClient (live or paper).
// Same code path for both modes — the client abstracts away venue specifics.
//
// Responsibilities:
//   executeEntry: leverage -> market entry -> open position row -> attach SL.
//   executeExit:  resolve qty from live position -> reduceOnly market -> close/decrement.
//
// All execution is wrapped by the caller in withSymbolLock(symbol, kind=entry|exit).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getClient } from "./bybit-client.ts";
import type { ExecutionMode } from "./execution-mode.ts";
import { computeEntrySizing, validateSymbolSizing } from "./sizing.ts";
import { resolveStrategyCode, isExit, sideOf, type SignalAction } from "./strategy-map.ts";
import { Trail } from "./trail.ts";

export interface ExecOutcome {
  ok: boolean;
  reason?: string;
  position_id?: string;
  order_id?: string | null;
  filled_qty?: number;
  fill_price?: number | null;
  protection_state?: string;
}

async function loadSymbolConfig(sb: SupabaseClient, symbol: string) {
  const { data, error } = await sb.from("symbols").select("*").eq("symbol", symbol).maybeSingle();
  if (error || !data) throw new Error(`symbol_config_missing:${symbol}`);
  return data;
}

async function logEvent(sb: SupabaseClient, positionId: string, type: string, detail: unknown) {
  await sb.from("position_events").insert({ position_id: positionId, event_type: type, detail });
}

function linkId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ----------------------------------------------------------------------------
// ENTRY
// ----------------------------------------------------------------------------
export async function executeEntry(
  sb: SupabaseClient,
  signal: any,
  mode: ExecutionMode,
  trail: Trail,
): Promise<ExecOutcome> {
  const client = getClient(mode, sb);
  const sym = await loadSymbolConfig(sb, signal.symbol);
  const action = signal.action as SignalAction;
  const side = sideOf(action);
  if (!side) return { ok: false, reason: "invalid_side" };

  // Live circuit breaker: block new live entries when halted (exits remain allowed).
  if (mode === "live") {
    const { data: settings } = await sb.from("app_settings")
      .select("live_risk_halted, live_risk_halt_reason").maybeSingle();
    if (settings?.live_risk_halted) {
      trail.add("live_risk_halted", "fail", settings.live_risk_halt_reason ?? "halted");
      return { ok: false, reason: `live_risk_halted:${settings.live_risk_halt_reason ?? "unknown"}` };
    }
  }

  // Reject if a live position already exists (entry per direction at a time).
  const existing = await client.getPosition(signal.symbol);
  if (existing.size > 0) {
    trail.add("entry_skipped", "skip", "position_already_open", { size: existing.size });
    return { ok: false, reason: "position_already_open" };
  }

  // Sizing.
  const errs = validateSymbolSizing(sym);
  if (errs.length) {
    trail.add("entry_sizing_invalid", "fail", errs.join(";"));
    return { ok: false, reason: `sizing_invalid:${errs.join(";")}` };
  }

  const wallet = await client.getWalletBalance();
  // Mark price: paper_market_prices for paper, signal payload otherwise.
  // For testnet/live the executor relies on the TradingView payload price; the
  // venue is the source of truth for fills (avgFillPrice replaces this).
  const { data: priceRow } = mode === "paper"
    ? await sb.from("paper_market_prices").select("price,received_at").eq("symbol", signal.symbol).maybeSingle()
    : { data: null as { price: number; received_at: string } | null };
  const payloadPrice = Number(signal.payload?.price ?? signal.payload?.close ?? NaN);
  const markPrice = priceRow ? Number(priceRow.price)
    : (Number.isFinite(payloadPrice) && payloadPrice > 0 ? payloadPrice : NaN);

  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    trail.add("entry_price_unavailable", "fail", "no_mark_price");
    return { ok: false, reason: "no_mark_price" };
  }

  const breakdown = computeEntrySizing(sym, {
    availableBalanceUsdt: wallet.availableBalance,
    markPrice,
  });
  trail.add("sizing", "info", undefined, breakdown as unknown as Record<string, unknown>);

  if (breakdown.exposureCapExceeded || breakdown.marginCapExceeded) {
    trail.add("entry_blocked_cap", "fail", breakdown.capRejectionReason ?? "cap_exceeded");
    await sb.from("risk_decisions").insert({
      signal_id: signal.id, gate: "exposure_limit", outcome: "block",
      reason: breakdown.capRejectionReason, metrics: breakdown as unknown as Record<string, unknown>,
    });
    return { ok: false, reason: `exposure_cap:${breakdown.capRejectionReason}` };
  }
  if (!(breakdown.estimatedQty > 0)) {
    trail.add("entry_qty_zero", "fail", "qty<=0");
    return { ok: false, reason: "qty_zero" };
  }

  // Apply leverage.
  await client.setLeverage(signal.symbol, breakdown.effectiveLeverage);

  // Create the position row first (so order can reference it).
  const { data: posRow, error: posErr } = await sb.from("positions").insert({
    symbol: signal.symbol, side, execution_mode: mode,
    qty_initial: breakdown.estimatedQty, qty_open: breakdown.estimatedQty,
    leverage: breakdown.effectiveLeverage,
    protection_state: "unprotected", unprotected_since: new Date().toISOString(),
    entry_signal_id: signal.id,
    last_seen_price: markPrice,
  }).select("*").single();
  if (posErr || !posRow) throw new Error(`position_insert_failed:${posErr?.message}`);

  const orderLink = linkId(`E-${signal.symbol}`);
  const submitSide = side === "long" ? "Buy" : "Sell";
  const fill = await client.submitOrder({
    symbol: signal.symbol, side: submitSide, qty: breakdown.estimatedQty,
    reduceOnly: false, orderLinkId: orderLink, signalId: signal.id, positionId: posRow.id,
    orderType: "Market", price: markPrice, purpose: "entry",
  });

  trail.add("entry_submitted", fill.status === "filled" ? "pass" : "fail", fill.message,
    { fill_price: fill.avgFillPrice, qty: fill.filledQty });

  if (fill.status !== "filled") {
    await sb.from("positions").update({
      closed_at: new Date().toISOString(), protection_state: "closed",
    }).eq("id", posRow.id);
    await logEvent(sb, posRow.id, "entry_failed", { fill });
    return { ok: false, reason: `entry_fill_failed:${fill.status}`, position_id: posRow.id };
  }

  const fillPrice = fill.avgFillPrice ?? markPrice;
  await sb.from("positions").update({
    entry_price: fillPrice,
    qty_initial: fill.filledQty, qty_open: fill.filledQty,
    last_seen_price: fillPrice,
    opened_at: new Date().toISOString(),
  }).eq("id", posRow.id);
  await logEvent(sb, posRow.id, "entry_filled",
    { fill_price: fillPrice, qty: fill.filledQty, fee: fill.feeUsdt });

  // SL placement (fixed % from entry).
  const slPct = Number(sym.sl_pct ?? 1.5) / 100;
  const slPrice = side === "long" ? fillPrice * (1 - slPct) : fillPrice * (1 + slPct);

  try {
    await client.setTradingStop({ symbol: signal.symbol, positionId: posRow.id, slPrice });
    await sb.from("positions").update({
      sl_price: slPrice, sl_order_id: linkId("SL"),
      protection_state: "sl_only", unprotected_since: null,
    }).eq("id", posRow.id);
    await logEvent(sb, posRow.id, "sl_armed", { sl_price: slPrice });
    trail.add("sl_armed", "pass", undefined, { sl_price: slPrice });
  } catch (e) {
    trail.add("sl_arm_failed", "fail", (e as Error).message);
    await sb.from("system_alerts").insert({
      severity: "critical", category: "unprotected_position",
      message: `SL placement failed for ${signal.symbol} — auto-flattening position`,
      context: { position_id: posRow.id, error: (e as Error).message, mode },
    });
    await sb.from("app_settings").update({ entries_paused: true }).eq("singleton", true);

    // Safety auto-close: SL could not be confirmed — flatten the position.
    try {
      const flattenLink = linkId(`AC-${signal.symbol}`);
      const closeSide = side === "long" ? "Sell" : "Buy";
      const closeFill = await client.submitOrder({
        symbol: signal.symbol, side: closeSide, qty: fill.filledQty,
        reduceOnly: true, orderLinkId: flattenLink,
        signalId: signal.id, positionId: posRow.id,
        orderType: "Market", price: fillPrice, purpose: "exit_full",
      });
      await sb.from("positions").update({
        qty_open: 0,
        closed_at: new Date().toISOString(),
        protection_state: "closed",
        last_seen_price: closeFill.avgFillPrice ?? fillPrice,
      }).eq("id", posRow.id);
      await logEvent(sb, posRow.id, "auto_closed_sl_unconfirmed",
        { close_fill: closeFill, original_fill_price: fillPrice });
      trail.add("auto_closed_sl_unconfirmed", "pass", undefined,
        { close_price: closeFill.avgFillPrice });
      return {
        ok: false, reason: "sl_unconfirmed_auto_closed",
        position_id: posRow.id, order_id: fill.bybitOrderId,
        filled_qty: fill.filledQty, fill_price: fillPrice, protection_state: "closed",
      };
    } catch (closeErr) {
      await sb.from("system_alerts").insert({
        severity: "critical", category: "unprotected_position",
        message: `Auto-close FAILED for ${signal.symbol} — manual intervention required`,
        context: { position_id: posRow.id, error: (closeErr as Error).message },
      });
      trail.add("auto_close_failed", "fail", (closeErr as Error).message);
    }
  }

  return {
    ok: true, position_id: posRow.id, order_id: fill.bybitOrderId,
    filled_qty: fill.filledQty, fill_price: fillPrice, protection_state: "sl_only",
  };
}

// ----------------------------------------------------------------------------
// EXIT
// ----------------------------------------------------------------------------
export async function executeExit(
  sb: SupabaseClient,
  signal: any,
  mode: ExecutionMode,
  trail: Trail,
): Promise<ExecOutcome> {
  const client = getClient(mode, sb);
  const action = signal.action as SignalAction;
  if (!isExit(action)) return { ok: false, reason: "not_exit_action" };
  const side = sideOf(action);
  if (!side) return { ok: false, reason: "invalid_side" };

  // Source of truth for size = live position from Bybit (or paper sim).
  const live = await client.getPosition(signal.symbol);
  if (live.size <= 0 || live.side !== side) {
    trail.add("exit_skipped", "skip", "no_matching_position",
      { live_side: live.side, live_size: live.size });
    return { ok: false, reason: "no_position" };
  }

  // Resolve local position row.
  const { data: posRow } = await sb.from("positions").select("*")
    .eq("symbol", signal.symbol).eq("execution_mode", mode)
    .is("closed_at", null).maybeSingle();
  if (!posRow) {
    trail.add("exit_drift", "fail", "live_position_no_local_row");
    await sb.from("system_alerts").insert({
      severity: "warning", category: "position_drift",
      message: `Exit signal for ${signal.symbol} but no local position row`,
      context: { signal_id: signal.id, live_size: live.size },
    });
    return { ok: false, reason: "drift_no_local_row" };
  }

  const sym = await loadSymbolConfig(sb, signal.symbol);
  const mapping = resolveStrategyCode(signal.strategy_code);
  const portion = mapping?.portion ?? signal.portion ?? "full";

  let qty = live.size;
  let purpose: "tp1" | "tp2_rest" | "exit_full" = "exit_full";
  if (portion === "tp1") {
    const pct = Number(sym.tp1_exit_percent ?? 100) / 100;
    qty = live.size * pct;
    purpose = "tp1";
  } else if (portion === "rest") {
    purpose = "tp2_rest";
  }
  qty = Math.min(qty, live.size);
  if (qty <= 0) {
    trail.add("exit_qty_zero", "fail");
    return { ok: false, reason: "qty_zero" };
  }

  const orderLink = linkId(`X-${signal.symbol}`);
  const submitSide = side === "long" ? "Sell" : "Buy";
  const { data: priceRow } = mode === "paper"
    ? await sb.from("paper_market_prices").select("price").eq("symbol", signal.symbol).maybeSingle()
    : { data: null as { price: number } | null };
  const refPrice = priceRow ? Number(priceRow.price) : (posRow.last_seen_price ?? posRow.entry_price);

  const fill = await client.submitOrder({
    symbol: signal.symbol, side: submitSide, qty, reduceOnly: true,
    orderLinkId: orderLink, signalId: signal.id, positionId: posRow.id,
    orderType: "Market", price: refPrice ?? undefined,
    purpose: mapping?.exitReason === "sl_failsafe" ? "sl"
      : mapping?.exitReason === "tp1" ? "tp1"
      : mapping?.exitReason === "tp2_rest" ? "tp2_rest"
      : "exit_full",
  });

  trail.add("exit_submitted", fill.status === "filled" ? "pass" : "fail", fill.message,
    { fill_price: fill.avgFillPrice, qty: fill.filledQty, purpose });

  if (fill.status !== "filled") {
    await logEvent(sb, posRow.id, "exit_failed", { fill, purpose });
    return { ok: false, reason: `exit_fill_failed:${fill.status}`, position_id: posRow.id };
  }

  const fillPrice = fill.avgFillPrice ?? Number(refPrice);
  const newQty = Math.max(0, Number(posRow.qty_open) - fill.filledQty);

  // PnL realization for paper mode wallet.
  if (mode === "paper" && posRow.entry_price != null) {
    const direction = side === "long" ? 1 : -1;
    const pnl = (fillPrice - Number(posRow.entry_price)) * fill.filledQty * direction;
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

  const patch: Record<string, unknown> = {
    qty_open: newQty, last_exit_signal_id: signal.id, last_seen_price: fillPrice,
  };
  if (purpose === "tp1") {
    patch.tp1_done = true;
    patch.tp1_qty = fill.filledQty;
  }
  if (purpose === "tp2_rest") patch.tp2_done = true;
  if (newQty <= 0) {
    patch.closed_at = new Date().toISOString();
    patch.protection_state = "closed";
  }
  await sb.from("positions").update(patch).eq("id", posRow.id);
  await logEvent(sb, posRow.id, `exit_${purpose}`, {
    qty: fill.filledQty, fill_price: fillPrice, remaining: newQty, reason: mapping?.exitReason,
  });

  return {
    ok: true, position_id: posRow.id, order_id: fill.bybitOrderId,
    filled_qty: fill.filledQty, fill_price: fillPrice,
    protection_state: newQty <= 0 ? "closed" : (posRow.protection_state as string),
  };
}
