import type { SymbolMetrics } from "@/lib/symbol-metrics";
import { MetricCard } from "@/components/overview/MetricCard";
import { fmtNum, fmtSigned, pnlTone } from "@/components/overview/format";

export function KpiGrid({
  metrics,
  effBalancePct,
  effLeverage,
  cfgBalancePct,
  cfgLeverage,
  unrealizedPnl,
}: {
  metrics: SymbolMetrics;
  effBalancePct: number | null;
  effLeverage: number | null;
  cfgBalancePct: number;
  cfgLeverage: number;
  unrealizedPnl: number;
}) {
  const subEff = (eff: number | null, cfg: number, suffix = "") =>
    eff != null && eff !== cfg ? `cfg ${fmtNum(cfg, suffix === "x" ? 0 : 1)}${suffix}` : null;

  const wrDelta = metrics.edge_winrate_delta;
  const pfDelta = metrics.edge_pf_delta;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <MetricCard
        label="Eff equity %"
        value={`${fmtNum(effBalancePct ?? cfgBalancePct, 1)}%`}
        sub={subEff(effBalancePct, cfgBalancePct, "%")}
      />
      <MetricCard
        label="Eff leverage"
        value={`${fmtNum(effLeverage ?? cfgLeverage, 0)}x`}
        sub={subEff(effLeverage, cfgLeverage, "x")}
      />
      <MetricCard
        label="Live winrate"
        value={metrics.live_winrate != null ? `${fmtNum(metrics.live_winrate, 1)}%` : "—"}
        sub={`${metrics.live_trades} trades · ${metrics.live_wins}W / ${metrics.live_losses}L`}
      />
      <MetricCard
        label="Backtest winrate"
        value={metrics.bt_winrate != null ? `${fmtNum(metrics.bt_winrate, 1)}%` : "—"}
        sub={
          wrDelta != null
            ? `live Δ ${fmtSigned(wrDelta, 1)}pp`
            : "ingen sammenligning"
        }
        tone={wrDelta != null ? (wrDelta >= 0 ? "success" : "danger") : "default"}
      />
      <MetricCard
        label="Live PF"
        value={metrics.live_profit_factor != null ? fmtNum(metrics.live_profit_factor, 2) : "—"}
        sub={metrics.live_trades < 3 ? "trenger ≥3 trades" : null}
      />
      <MetricCard
        label="Backtest PF"
        value={metrics.bt_profit_factor != null ? fmtNum(metrics.bt_profit_factor, 2) : "—"}
        sub={pfDelta != null ? `live Δ ${fmtSigned(pfDelta, 2)}` : null}
        tone={pfDelta != null ? (pfDelta >= 0 ? "success" : "danger") : "default"}
      />
      <MetricCard
        label="Realized PnL"
        value={fmtSigned(metrics.live_realized_pnl, 2)}
        sub={
          metrics.live_avg_pnl_pct != null
            ? `avg ${fmtSigned(metrics.live_avg_pnl_pct, 2)}%/trade`
            : null
        }
        tone={metrics.live_realized_pnl >= 0 ? "success" : "danger"}
      />
      <MetricCard
        label="Unrealized PnL"
        value={fmtSigned(unrealizedPnl, 2)}
        tone={unrealizedPnl > 0 ? "success" : unrealizedPnl < 0 ? "danger" : "default"}
        sub={
          metrics.live_max_drawdown_pct != null
            ? `max DD ${fmtNum(metrics.live_max_drawdown_pct, 1)}%`
            : null
        }
      />
    </div>
  );
}

// Avoid unused-import warning when callers don't need pnlTone here.
void pnlTone;
