// Pure scoring helpers for Coin Admission Screener.
// No I/O — easy to test.

export type AdmissionMode = 'strict' | 'trend_adjusted';
export type AdmissionStatus = 'approved' | 'watchlist' | 'trend_candidate' | 'rejected';

export interface AdmissionThresholds {
  max_rank: number;
  min_turnover_24h_usd: number;
  min_turnover_7d_median_usd: number;
  min_open_interest_value_usd: number;
  min_listing_age_days: number;
  max_spread_bps: number;
  max_slippage_bps: number;
  max_funding_abs: number;
  max_1h_drop_pct_30d: number;
  order_size_usd_for_slippage: number;
  approved_min_score: number;
  watchlist_min_score: number;
  // Trend Adjusted extras (optional in old data)
  trend_adjusted_enabled?: boolean;
  min_trend_score_for_soften?: number;
  trend_candidate_min_robustness?: number;
  trend_candidate_min_trend?: number;
  strategy_fit_weight_robustness?: number;
  strategy_fit_weight_trend?: number;
}

export interface AdmissionWeights {
  rank: number;
  turnover: number;
  open_interest: number;
  depth_slippage: number;
  listing_age: number;
  wick_volatility: number;
  funding_normality: number;
}

export interface SymbolMetrics {
  symbol: string;
  rank: number | null;
  turnover_24h: number | null;
  turnover_7d_median: number | null;
  turnover_30d_median: number | null;
  open_interest_value: number | null;
  spread_bps: number | null;
  listing_age_days: number | null;
  funding_rate: number | null;
  max_1h_drop_pct: number | null;
  extreme_wick_count: number | null;
}

export interface ScoreBreakdown {
  rank: number;
  turnover: number;
  open_interest: number;
  depth_slippage: number;
  listing_age: number;
  wick_volatility: number;
  funding_normality: number;
}

export interface AdmissionScore {
  score: number;                       // robustness 0..100
  trend_score: number | null;
  strategy_fit_score: number;
  status: AdmissionStatus;
  components: ScoreBreakdown;
  hard_kill_rules: string[];
  soft_failures: string[];
  /** Union of hard + soft for backward compatibility. */
  kill_rules_triggered: string[];
  wick_risk_score: number | null;
  admission_reason: string;
}

function ramp(value: number | null, lo: number, hi: number): number {
  if (value == null || !Number.isFinite(value)) return 0;
  if (value <= lo) return 0;
  if (value >= hi) return 100;
  return ((value - lo) / (hi - lo)) * 100;
}

function rampInv(value: number | null, lo: number, hi: number): number {
  if (value == null || !Number.isFinite(value)) return 50;
  if (value <= lo) return 100;
  if (value >= hi) return 0;
  return (1 - (value - lo) / (hi - lo)) * 100;
}

function scoreRank(rank: number | null, maxRank: number): number {
  if (rank == null) return 30;
  if (rank <= 1) return 100;
  if (rank > maxRank * 2) return 0;
  if (rank <= maxRank) return 100 - ((rank - 1) / (maxRank - 1)) * 50;
  return 50 - ((rank - maxRank) / maxRank) * 50;
}

function computeWickComponent(m: SymbolMetrics, t: AdmissionThresholds): number {
  if (m.max_1h_drop_pct == null && m.extreme_wick_count == null) return 50;
  const dropComp = rampInv(m.max_1h_drop_pct, 5, t.max_1h_drop_pct_30d);
  const wickComp = m.extreme_wick_count != null ? rampInv(m.extreme_wick_count, 0, 10) : 50;
  return dropComp * 0.7 + wickComp * 0.3;
}

export interface ScoreOptions {
  mode: AdmissionMode;
  /** Historical Trend Quality v2 score (drives Strategy Fit + Trend Adjusted status). */
  htqScore: number | null;
  /** Current Momentum / live EMA alignment (informational only). */
  momentumScore: number | null;
  /** When HTQ was computed from <14d lookback: status decisions don't promote. */
  htqMode?: 'standard' | 'emerging';
}



export function computeAdmissionScore(
  m: SymbolMetrics,
  t: AdmissionThresholds,
  w: AdmissionWeights,
  opts: ScoreOptions = { mode: 'strict', trendScore: null },
): AdmissionScore {
  const hard: string[] = [];
  const soft: string[] = [];

  // ---- Hard kill rules (no Trend Score can rescue) ----
  // Extremely young listing (<7d is dangerous regardless of profile).
  if (m.listing_age_days != null && m.listing_age_days < 7) {
    hard.push(`age<7d (very new listing)`);
  }
  // Extremely low 24h turnover (less than 10% of threshold)
  if (m.turnover_24h != null && m.turnover_24h < t.min_turnover_24h_usd * 0.1) {
    hard.push(`24h_turnover<${((t.min_turnover_24h_usd * 0.1) / 1e6).toFixed(1)}M (critically low liquidity)`);
  }
  // Spread far above threshold
  if (m.spread_bps != null && m.spread_bps > t.max_spread_bps * 2) {
    hard.push(`spread>${(t.max_spread_bps * 2).toFixed(1)}bps (dangerous spread)`);
  }
  // Extreme wick events
  if (m.max_1h_drop_pct != null && m.max_1h_drop_pct > t.max_1h_drop_pct_30d * 2) {
    hard.push(`1h_wick>${(t.max_1h_drop_pct_30d * 2).toFixed(0)}% (extreme spike risk)`);
  }
  // Missing critical data
  if (m.turnover_24h == null && m.turnover_7d_median == null) {
    hard.push('missing_market_data');
  }

  // ---- Soft requirements ----
  if (m.rank != null && m.rank > t.max_rank) {
    soft.push(`rank>${t.max_rank}`);
  } else if (m.rank == null) {
    soft.push('rank_unknown');
  }
  if (m.turnover_7d_median != null && m.turnover_7d_median < t.min_turnover_7d_median_usd) {
    soft.push(`7d_median<${(t.min_turnover_7d_median_usd / 1e6).toFixed(0)}M`);
  }
  if (m.turnover_24h != null
      && m.turnover_24h >= t.min_turnover_24h_usd * 0.1
      && m.turnover_24h < t.min_turnover_24h_usd) {
    soft.push(`24h<${(t.min_turnover_24h_usd / 1e6).toFixed(0)}M`);
  }
  if (m.open_interest_value != null && m.open_interest_value < t.min_open_interest_value_usd) {
    soft.push(`OI<${(t.min_open_interest_value_usd / 1e6).toFixed(0)}M`);
  }
  if (m.spread_bps != null
      && m.spread_bps > t.max_spread_bps
      && m.spread_bps <= t.max_spread_bps * 2) {
    soft.push(`spread>${t.max_spread_bps}bps`);
  }
  if (m.listing_age_days != null
      && m.listing_age_days >= 7
      && m.listing_age_days < t.min_listing_age_days) {
    soft.push(`age<${t.min_listing_age_days}d`);
  }
  if (m.funding_rate != null && Math.abs(m.funding_rate) > t.max_funding_abs) {
    soft.push(`|funding|>${(t.max_funding_abs * 100).toFixed(3)}%`);
  }
  if (m.max_1h_drop_pct != null
      && m.max_1h_drop_pct > t.max_1h_drop_pct_30d
      && m.max_1h_drop_pct <= t.max_1h_drop_pct_30d * 2) {
    soft.push(`1h_drop>${t.max_1h_drop_pct_30d}%`);
  }

  // ---- Robustness components ----
  const c_rank = scoreRank(m.rank, t.max_rank);
  const c_turn24 = ramp(m.turnover_24h, t.min_turnover_24h_usd * 0.5, t.min_turnover_24h_usd * 4);
  const c_turn7 = ramp(m.turnover_7d_median, t.min_turnover_7d_median_usd * 0.5, t.min_turnover_7d_median_usd * 4);
  const c_turnover = m.turnover_7d_median != null ? c_turn24 * 0.4 + c_turn7 * 0.6 : c_turn24;
  const c_oi = ramp(m.open_interest_value, t.min_open_interest_value_usd * 0.5, t.min_open_interest_value_usd * 4);
  const c_spread = rampInv(m.spread_bps, 1, t.max_spread_bps);
  const c_age = ramp(m.listing_age_days, t.min_listing_age_days * 0.5, t.min_listing_age_days * 4);
  const c_wick = computeWickComponent(m, t);
  const c_funding = rampInv(
    m.funding_rate != null ? Math.abs(m.funding_rate) : null,
    0.0001,
    t.max_funding_abs,
  );

  const components: ScoreBreakdown = {
    rank: c_rank,
    turnover: c_turnover,
    open_interest: c_oi,
    depth_slippage: c_spread,
    listing_age: c_age,
    wick_volatility: c_wick,
    funding_normality: c_funding,
  };

  const weightedScore =
    c_rank * w.rank +
    c_turnover * w.turnover +
    c_oi * w.open_interest +
    c_spread * w.depth_slippage +
    c_age * w.listing_age +
    c_wick * w.wick_volatility +
    c_funding * w.funding_normality;

  const totalWeight =
    w.rank + w.turnover + w.open_interest +
    w.depth_slippage + w.listing_age + w.wick_volatility + w.funding_normality;

  const robustness = totalWeight > 0 ? weightedScore / totalWeight : 0;

  // ---- Strategy Fit Score ----
  const wRob = t.strategy_fit_weight_robustness ?? 0.6;
  const wTrend = t.strategy_fit_weight_trend ?? 0.4;
  const trendForFit = opts.trendScore ?? robustness;
  const strategyFit = robustness * wRob + trendForFit * wTrend;

  // ---- Status decision ----
  let status: AdmissionStatus;
  let reason: string;

  if (hard.length > 0) {
    status = 'rejected';
    reason = `Failed hard kill rule: ${hard[0]}`;
  } else if (opts.mode === 'strict') {
    // Strict: any soft failure also rejects (back-compat with original behaviour)
    if (soft.length > 0) {
      status = 'rejected';
      reason = `Strict mode: failed requirement: ${soft[0]}`;
    } else if (robustness >= t.approved_min_score) {
      status = 'approved';
      reason = 'Strong robustness across all metrics';
    } else if (robustness >= t.watchlist_min_score) {
      status = 'watchlist';
      reason = 'Borderline robustness';
    } else {
      status = 'rejected';
      reason = 'Robustness below watchlist threshold';
    }
  } else {
    // Trend Adjusted
    const trend = opts.trendScore ?? 0;
    const minTrendCand = t.trend_candidate_min_trend ?? 75;
    const minRobCand = t.trend_candidate_min_robustness ?? 55;

    if (robustness >= 80) {
      status = 'approved';
      reason = 'Strong robustness and good trend quality';
    } else if (robustness >= 70 && trend >= 80) {
      status = 'approved';
      reason = 'Acceptable robustness, strong trend quality';
    } else if (robustness >= 65) {
      status = 'watchlist';
      reason = 'Borderline robustness';
    } else if (robustness >= 55 && trend >= 75) {
      status = 'watchlist';
      reason = 'Acceptable robustness, strong trend quality';
    } else if (robustness >= minRobCand && trend >= minTrendCand) {
      status = 'trend_candidate';
      reason = 'Lower robustness, but strong trend profile and no hard kill rules';
    } else {
      status = 'rejected';
      reason = 'Insufficient robustness and trend quality';
    }
  }

  const wickRiskScore = m.max_1h_drop_pct != null || m.extreme_wick_count != null
    ? Math.round((100 - c_wick) * 10) / 10
    : null;

  return {
    score: Math.round(robustness * 10) / 10,
    trend_score: opts.trendScore != null ? Math.round(opts.trendScore * 10) / 10 : null,
    strategy_fit_score: Math.round(strategyFit * 10) / 10,
    status,
    components,
    hard_kill_rules: hard,
    soft_failures: soft,
    kill_rules_triggered: [...hard, ...soft],
    wick_risk_score: wickRiskScore,
    admission_reason: reason,
  };
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
