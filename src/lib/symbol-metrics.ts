// Pure per-symbol metrics aggregator. Gjenbrukes av den fremtidige Screener-siden
// uten endringer — hold dette filen ren for I/O og DOM.

export type HealthSnapshotLite = {
  symbol: string;
  strategy: string;
  tag: string | null;
  winrate: number | null;
  profit_factor: number | null;
  net_profit: number | null;
  bar_time: string | null;
  created_at: string;
  payload?: Record<string, any> | null;
};

export type PositionLite = {
  id: string;
  symbol: string;
  side: "long" | "short" | string;
  entry_price: number | null;
  qty_initial: number | null;
  qty_open: number | null;
  realized_pnl: number;
  opened_at: string;
  closed_at: string | null;
};

export type SignalLite = {
  id: string;
  symbol: string | null;
  type: string;
  action: string | null;
  status: string;
  decision_reason: string | null;
  created_at: string;
};

export type PositionEventLite = {
  id: string;
  position_id: string;
  event_type: string;
  detail: Record<string, unknown> | null;
  created_at: string;
};

export interface SymbolMetrics {
  symbol: string;

  // Backtest (fra siste health_snapshot for symbolet)
  bt_winrate: number | null;
  bt_profit_factor: number | null;
  bt_net_profit: number | null;
  bt_last_at: string | null;

  // Live execution (closed positions)
  live_trades: number;
  live_wins: number;
  live_losses: number;
  live_winrate: number | null;
  live_profit_factor: number | null;
  live_realized_pnl: number;
  live_avg_pnl_pct: number | null;
  live_max_drawdown_pct: number | null;
  live_avg_time_in_trade_sec: number | null;

  // Edge-delta (live − backtest); null hvis et av sidene mangler
  edge_winrate_delta: number | null;
  edge_pf_delta: number | null;

  // Reliability
  signals_total: number;
  signals_rejected: number;
  signals_error: number;
  rejection_rate: number;
  recovery_events: number;

  // Composite scores (0–100, vekter justeres senere)
  profitability_score: number | null;
  signal_quality_score: number | null;
  reliability_score: number | null;
}

function pctFromPnl(p: PositionLite): number | null {
  const ep = p.entry_price;
  const q = p.qty_initial ?? p.qty_open;
  if (ep == null || !q || ep <= 0 || q <= 0) return null;
  const notional = ep * q;
  if (notional <= 0) return null;
  return (p.realized_pnl / notional) * 100;
}

function clamp01to100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function computeSymbolMetrics(input: {
  symbol: string;
  health: HealthSnapshotLite[];
  closedPositions: PositionLite[];
  signals: SignalLite[];
  positionEvents: PositionEventLite[];
}): SymbolMetrics {
  const { symbol, health, closedPositions, signals, positionEvents } = input;

  // ── Backtest: foretrekk HEALTH_ALL heartbeat, fall tilbake til siste snapshot
  const healthForSym = health.filter((h) => h.symbol === symbol);
  const heartbeat = healthForSym.find((h) => h.strategy === "HEALTH_ALL");
  const latestBt = heartbeat ?? healthForSym[0] ?? null;

  // ── Live (closed positions)
  const closed = closedPositions.filter((p) => p.symbol === symbol && p.closed_at);
  const trades = closed.length;
  const wins = closed.filter((p) => p.realized_pnl > 0).length;
  const losses = closed.filter((p) => p.realized_pnl < 0).length;
  const grossProfit = closed.reduce((s, p) => s + Math.max(0, p.realized_pnl), 0);
  const grossLoss = closed.reduce((s, p) => s + Math.max(0, -p.realized_pnl), 0);
  const realized = closed.reduce((s, p) => s + p.realized_pnl, 0);
  const live_winrate = trades ? (wins / trades) * 100 : null;
  const live_profit_factor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : null;

  const pcts = closed.map(pctFromPnl).filter((v): v is number => v != null);
  const live_avg_pnl_pct = pcts.length ? pcts.reduce((s, v) => s + v, 0) / pcts.length : null;

  // Equity-kurve for max drawdown
  let peak = 0;
  let cum = 0;
  let maxDdAbs = 0;
  for (const p of [...closed].sort(
    (a, b) => new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime(),
  )) {
    cum += p.realized_pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDdAbs) maxDdAbs = dd;
  }
  const live_max_drawdown_pct = peak > 0 ? -(maxDdAbs / peak) * 100 : null;

  const durations = closed
    .filter((p) => p.opened_at && p.closed_at)
    .map((p) => (new Date(p.closed_at!).getTime() - new Date(p.opened_at).getTime()) / 1000);
  const live_avg_time_in_trade_sec = durations.length
    ? durations.reduce((s, v) => s + v, 0) / durations.length
    : null;

  // ── Reliability
  const sigForSym = signals.filter((s) => s.symbol === symbol);
  const signals_total = sigForSym.length;
  const signals_rejected = sigForSym.filter((s) => s.status === "rejected").length;
  const signals_error = sigForSym.filter((s) => s.status === "error").length;
  const rejection_rate = signals_total
    ? ((signals_rejected + signals_error) / signals_total) * 100
    : 0;
  const positionIds = new Set(closed.map((p) => p.id));
  const recovery_events = positionEvents.filter(
    (e) => positionIds.has(e.position_id) && e.event_type.startsWith("recovery_"),
  ).length;

  // ── Edge delta
  const edge_winrate_delta =
    live_winrate != null && latestBt?.winrate != null
      ? live_winrate - Number(latestBt.winrate)
      : null;
  const edge_pf_delta =
    live_profit_factor != null &&
    Number.isFinite(live_profit_factor) &&
    latestBt?.profit_factor != null
      ? live_profit_factor - Number(latestBt.profit_factor)
      : null;

  // ── Composite scores (enkle, justerbare vekter)
  // Profitability: mix av live winrate (0-100) og PF cap=3 → 33.3 per enhet
  const profitability_score =
    trades >= 3 && live_winrate != null
      ? clamp01to100(
          0.6 * live_winrate +
            0.4 * (live_profit_factor != null && Number.isFinite(live_profit_factor)
              ? Math.min(live_profit_factor, 3) * 33.33
              : 0),
        )
      : null;

  const signal_quality_score = signals_total >= 5 ? clamp01to100(100 - rejection_rate) : null;

  const reliability_score =
    signals_total >= 5
      ? clamp01to100(100 - rejection_rate - Math.min(recovery_events * 5, 50))
      : null;

  return {
    symbol,
    bt_winrate: latestBt?.winrate != null ? Number(latestBt.winrate) : null,
    bt_profit_factor: latestBt?.profit_factor != null ? Number(latestBt.profit_factor) : null,
    bt_net_profit: latestBt?.net_profit != null ? Number(latestBt.net_profit) : null,
    bt_last_at: latestBt?.created_at ?? null,

    live_trades: trades,
    live_wins: wins,
    live_losses: losses,
    live_winrate,
    live_profit_factor:
      live_profit_factor != null && Number.isFinite(live_profit_factor) ? live_profit_factor : null,
    live_realized_pnl: realized,
    live_avg_pnl_pct,
    live_max_drawdown_pct,
    live_avg_time_in_trade_sec,

    edge_winrate_delta,
    edge_pf_delta,

    signals_total,
    signals_rejected,
    signals_error,
    rejection_rate,
    recovery_events,

    profitability_score,
    signal_quality_score,
    reliability_score,
  };
}
