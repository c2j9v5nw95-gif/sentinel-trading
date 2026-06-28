/**
 * Sizing & leverage helpers for backtest results.
 *
 * Backtest auto-classification uses position-size-normalized and
 * leverage-adjusted estimates alongside the raw TradingView ("account")
 * numbers. Originals are never overwritten.
 *
 * Defaults reflect the live bot configuration:
 *   - initial_capital_usd = 10000
 *   - position_size_type  = 'percent_of_equity'
 *   - position_size_pct   = 5
 *   - leverage            = 10
 *   - leverage_enabled    = true
 *
 *   normalized_*          = account_* / (position_size_pct / 100)
 *   leverage_adjusted_*   = account_* * leverage  (only if leverage_enabled)
 *
 * Leverage-adjusted values are ESTIMATES — they do not model funding,
 * slippage, liquidation, margin rules or live execution differences.
 */

export type SizingAssumptionSource =
  | 'default_backfill'
  | 'user_confirmed'
  | 'imported_from_screenshot'
  | 'manual_override';

export type PositionSizeType = 'percent_of_equity';

export type SizingInput = {
  position_size_type?: PositionSizeType | null;
  position_size_pct?: number | null;
  leverage?: number | null;
  leverage_enabled?: boolean | null;
};

export type SizingMetricsInput = {
  net_profit_pct?: number | null;
  max_drawdown_pct?: number | null;
  avg_pnl_pct?: number | null;
};

export type SizingDerived = {
  notional_exposure_pct: number | null;
  normalized_net_profit_pct: number | null;
  normalized_drawdown_pct: number | null;
  normalized_avg_trade_pct: number | null;
  leverage_adjusted_net_profit_pct: number | null;
  leverage_adjusted_drawdown_pct: number | null;
  warnings: string[];
};

export const SIZING_DEFAULTS = {
  initial_capital_usd: 10000,
  position_size_type: 'percent_of_equity' as PositionSizeType,
  position_size_pct: 5,
  leverage: 10,
  leverage_enabled: true,
};

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Apply defaults to any missing sizing fields. */
export function withSizingDefaults(s: SizingInput | null | undefined) {
  const pst = (s?.position_size_type ?? SIZING_DEFAULTS.position_size_type) as PositionSizeType;
  const psp = num(s?.position_size_pct) ?? SIZING_DEFAULTS.position_size_pct;
  const lev = num(s?.leverage) ?? SIZING_DEFAULTS.leverage;
  const le = s?.leverage_enabled == null ? SIZING_DEFAULTS.leverage_enabled : !!s.leverage_enabled;
  return {
    position_size_type: pst,
    position_size_pct: psp,
    leverage: lev,
    leverage_enabled: le,
  };
}

/**
 * Pure compute of derived sizing fields. Guardrails:
 *  - position_size_pct must be > 0 for normalization; otherwise nulls + warning
 *  - leverage must be >= 1 when leverage_enabled; otherwise nulls + warning
 *  - missing source metric → derived metric stays null
 */
export function computeSizingDerived(
  sizing: SizingInput | null | undefined,
  metrics: SizingMetricsInput,
): SizingDerived {
  const s = withSizingDefaults(sizing);
  const warnings: string[] = [];

  const np = num(metrics.net_profit_pct);
  const dd = num(metrics.max_drawdown_pct);
  const avgT = num(metrics.avg_pnl_pct);

  let normalizedNet: number | null = null;
  let normalizedDd: number | null = null;
  let normalizedAvg: number | null = null;
  let notional: number | null = null;
  let levNet: number | null = null;
  let levDd: number | null = null;

  if (!(s.position_size_pct > 0)) {
    warnings.push('position_size_pct_invalid');
  }
  if (s.leverage_enabled && !(s.leverage >= 1)) {
    warnings.push('leverage_below_1');
  }

  // Notional exposure %
  if (s.position_size_pct > 0) {
    notional = s.leverage_enabled && s.leverage >= 1
      ? s.position_size_pct * s.leverage
      : s.position_size_pct;
  }

  // Normalized metrics (account result mapped to "per 100% position size")
  if (s.position_size_pct > 0) {
    const share = s.position_size_pct / 100;
    if (np != null) normalizedNet = np / share;
    if (dd != null) normalizedDd = dd / share;
    if (avgT != null) normalizedAvg = avgT / share;
  }

  // Leverage-adjusted estimate
  const levOn = s.leverage_enabled && s.leverage >= 1;
  if (np != null) levNet = levOn ? np * s.leverage : np;
  if (dd != null) levDd = levOn ? dd * s.leverage : dd;

  return {
    notional_exposure_pct: notional,
    normalized_net_profit_pct: normalizedNet,
    normalized_drawdown_pct: normalizedDd,
    normalized_avg_trade_pct: normalizedAvg,
    leverage_adjusted_net_profit_pct: levNet,
    leverage_adjusted_drawdown_pct: levDd,
    warnings,
  };
}
