// live-risk-monitor — global circuit breaker for live trading.
//
// Runs every minute via pg_cron. Evaluates 6 thresholds against LIVE positions
// only. If any threshold is breached AND the system is not already halted,
// it flips app_settings.live_risk_halted = true via trigger_live_risk_halt(),
// which also raises a critical system_alert. Operator must call
// rpc('acknowledge_live_risk_halt') to resume.
//
// Thresholds (all configurable in app_settings):
//   1. live_risk_max_daily_loss_pct        — sum(realized_pnl) today vs equity
//   2. live_risk_max_consecutive_losses    — count of consecutive losing closes
//   3. live_risk_max_open_positions        — count of open live positions
//   4. live_risk_max_total_exposure_pct    — sum(notional) / equity
//   5. live_risk_max_unrealized_drawdown_pct — sum(unrealized) / equity (negative)
//   6. live_risk_max_symbol_exposure_pct   — max single-symbol notional / equity

import { serviceClient, corsHeaders } from "../_shared/db.ts";

interface Settings {
  live_enabled: boolean;
  live_risk_halted: boolean;
  live_risk_max_daily_loss_pct: number;
  live_risk_max_consecutive_losses: number;
  live_risk_max_open_positions: number;
  live_risk_max_total_exposure_pct: number;
  live_risk_max_unrealized_drawdown_pct: number;
  live_risk_max_symbol_exposure_pct: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const sb = serviceClient();

  const { data: s } = await sb.from("app_settings").select("*").maybeSingle();
  const settings = s as Settings | null;
  if (!settings) return json({ ok: false, reason: "no_settings" });

  // No-op when live mode is globally off — nothing to halt.
  if (!settings.live_enabled) return json({ ok: true, skipped: "live_disabled" });
  if (settings.live_risk_halted) return json({ ok: true, skipped: "already_halted" });

  // Use paper_wallet equity as the equity reference (single source we always have).
  // For live, this is the operator's tracked equity baseline.
  const { data: wallet } = await sb.from("paper_wallet").select("equity_usdt").maybeSingle();
  const equity = Math.max(1, Number(wallet?.equity_usdt ?? 10000));

  // ---- Open live positions
  const { data: openLive } = await sb.from("positions")
    .select("id, symbol, side, qty_open, entry_price, last_seen_price, realized_pnl")
    .eq("execution_mode", "live")
    .is("closed_at", null);
  const open = openLive ?? [];
  const openCount = open.length;

  let totalNotional = 0;
  let unrealized = 0;
  const symbolNotional: Record<string, number> = {};
  for (const p of open) {
    const qty = Number(p.qty_open ?? 0);
    const entry = Number(p.entry_price ?? 0);
    const last = Number(p.last_seen_price ?? entry);
    const direction = p.side === "long" ? 1 : -1;
    const notional = qty * last;
    totalNotional += notional;
    symbolNotional[p.symbol] = (symbolNotional[p.symbol] ?? 0) + notional;
    if (entry > 0) unrealized += (last - entry) * qty * direction;
  }

  // ---- Realized PnL today (UTC) for closed live positions
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data: closedToday } = await sb.from("positions")
    .select("realized_pnl, closed_at")
    .eq("execution_mode", "live")
    .gte("closed_at", since.toISOString());
  const dailyRealized = (closedToday ?? []).reduce((sum, r) => sum + Number(r.realized_pnl ?? 0), 0);

  // ---- Consecutive losses (most recent N closed live positions)
  const { data: lastClosed } = await sb.from("positions")
    .select("realized_pnl, closed_at")
    .eq("execution_mode", "live")
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false })
    .limit(50);
  let consecutiveLosses = 0;
  for (const r of (lastClosed ?? [])) {
    if (Number(r.realized_pnl ?? 0) < 0) consecutiveLosses++;
    else break;
  }

  // ---- Derived metrics
  const dailyLossPct = dailyRealized < 0 ? Math.abs(dailyRealized) / equity * 100 : 0;
  const totalExposurePct = totalNotional / equity * 100;
  const drawdownPct = unrealized < 0 ? Math.abs(unrealized) / equity * 100 : 0;
  const maxSymbolNotional = Math.max(0, ...Object.values(symbolNotional));
  const maxSymbolExposurePct = maxSymbolNotional / equity * 100;
  const maxSymbol = Object.entries(symbolNotional)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const metrics = {
    equity,
    open_positions: openCount,
    daily_realized_usdt: Number(dailyRealized.toFixed(4)),
    daily_loss_pct: Number(dailyLossPct.toFixed(3)),
    consecutive_losses: consecutiveLosses,
    total_notional_usdt: Number(totalNotional.toFixed(4)),
    total_exposure_pct: Number(totalExposurePct.toFixed(3)),
    unrealized_pnl_usdt: Number(unrealized.toFixed(4)),
    unrealized_drawdown_pct: Number(drawdownPct.toFixed(3)),
    max_symbol: maxSymbol,
    max_symbol_exposure_pct: Number(maxSymbolExposurePct.toFixed(3)),
  };

  // ---- Evaluate breaches
  const breaches: { code: string; reason: string }[] = [];
  if (dailyLossPct >= settings.live_risk_max_daily_loss_pct) {
    breaches.push({
      code: "daily_loss",
      reason: `daily loss ${dailyLossPct.toFixed(2)}% ≥ limit ${settings.live_risk_max_daily_loss_pct}%`,
    });
  }
  if (consecutiveLosses >= settings.live_risk_max_consecutive_losses) {
    breaches.push({
      code: "consecutive_losses",
      reason: `${consecutiveLosses} consecutive losses ≥ limit ${settings.live_risk_max_consecutive_losses}`,
    });
  }
  if (openCount > settings.live_risk_max_open_positions) {
    breaches.push({
      code: "max_open_positions",
      reason: `${openCount} open live positions > limit ${settings.live_risk_max_open_positions}`,
    });
  }
  if (totalExposurePct >= settings.live_risk_max_total_exposure_pct) {
    breaches.push({
      code: "total_exposure",
      reason: `total exposure ${totalExposurePct.toFixed(2)}% ≥ limit ${settings.live_risk_max_total_exposure_pct}%`,
    });
  }
  if (drawdownPct >= settings.live_risk_max_unrealized_drawdown_pct) {
    breaches.push({
      code: "unrealized_drawdown",
      reason: `unrealized drawdown ${drawdownPct.toFixed(2)}% ≥ limit ${settings.live_risk_max_unrealized_drawdown_pct}%`,
    });
  }
  if (maxSymbolExposurePct >= settings.live_risk_max_symbol_exposure_pct) {
    breaches.push({
      code: "symbol_correlation",
      reason: `${maxSymbol} exposure ${maxSymbolExposurePct.toFixed(2)}% ≥ limit ${settings.live_risk_max_symbol_exposure_pct}%`,
    });
  }

  if (breaches.length === 0) {
    return json({ ok: true, breached: false, metrics });
  }

  const reason = breaches.map((b) => `[${b.code}] ${b.reason}`).join("; ");
  await sb.rpc("trigger_live_risk_halt", {
    _reason: reason,
    _metrics: { ...metrics, breaches },
  });

  return json({ ok: true, breached: true, reason, metrics, breaches });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
