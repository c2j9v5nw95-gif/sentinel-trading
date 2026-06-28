// Pure scoring helpers for Coin Admission Screener.
// No I/O — easy to test.

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
  score: number;
  status: 'approved' | 'watchlist' | 'rejected';
  components: ScoreBreakdown;
  kill_rules_triggered: string[];
  wick_risk_score: number | null;
}

/** Linear ramp: 0 below `lo`, 100 above `hi`, scaled in between. */
function ramp(value: number | null, lo: number, hi: number): number {
  if (value == null || !Number.isFinite(value)) return 0;
  if (value <= lo) return 0;
  if (value >= hi) return 100;
  return ((value - lo) / (hi - lo)) * 100;
}

/** Inverse ramp: 100 below `lo`, 0 above `hi`. */
function rampInv(value: number | null, lo: number, hi: number): number {
  if (value == null || !Number.isFinite(value)) return 50; // unknown = neutral
  if (value <= lo) return 100;
  if (value >= hi) return 0;
  return (1 - (value - lo) / (hi - lo)) * 100;
}

/** Rank scoring: top rank = 100, rank == max_rank = 30, beyond = 0. */
function scoreRank(rank: number | null, maxRank: number): number {
  if (rank == null) return 30; // unknown rank = below-average but not zero
  if (rank <= 1) return 100;
  if (rank > maxRank * 2) return 0;
  if (rank <= maxRank) {
    // 1 → 100, maxRank → 50
    return 100 - ((rank - 1) / (maxRank - 1)) * 50;
  }
  // maxRank → 50, 2*maxRank → 0
  return 50 - ((rank - maxRank) / maxRank) * 50;
}

export function computeAdmissionScore(
  m: SymbolMetrics,
  thresholds: AdmissionThresholds,
  weights: AdmissionWeights,
): AdmissionScore {
  // Kill rules first
  const kills: string[] = [];
  if (m.listing_age_days != null && m.listing_age_days < thresholds.min_listing_age_days) {
    kills.push(`age<${thresholds.min_listing_age_days}d`);
  }
  if (m.rank != null && m.rank > thresholds.max_rank) {
    kills.push(`rank>${thresholds.max_rank}`);
  }
  if (m.turnover_7d_median != null && m.turnover_7d_median < thresholds.min_turnover_7d_median_usd) {
    kills.push(`7d_median<${(thresholds.min_turnover_7d_median_usd / 1e6).toFixed(0)}M`);
  }
  if (m.turnover_24h != null && m.turnover_24h < thresholds.min_turnover_24h_usd) {
    kills.push(`24h<${(thresholds.min_turnover_24h_usd / 1e6).toFixed(0)}M`);
  }
  if (m.open_interest_value != null && m.open_interest_value < thresholds.min_open_interest_value_usd) {
    kills.push(`OI<${(thresholds.min_open_interest_value_usd / 1e6).toFixed(0)}M`);
  }
  if (m.spread_bps != null && m.spread_bps > thresholds.max_spread_bps) {
    kills.push(`spread>${thresholds.max_spread_bps}bps`);
  }
  if (m.funding_rate != null && Math.abs(m.funding_rate) > thresholds.max_funding_abs) {
    kills.push(`|funding|>${(thresholds.max_funding_abs * 100).toFixed(3)}%`);
  }
  if (m.max_1h_drop_pct != null && m.max_1h_drop_pct > thresholds.max_1h_drop_pct_30d) {
    kills.push(`1h_drop>${thresholds.max_1h_drop_pct_30d}%`);
  }

  // Score components 0..100
  const c_rank = scoreRank(m.rank, thresholds.max_rank);
  // turnover: blend 24h (40%) + 7d median (60%) against 4x the threshold
  const minTurn = thresholds.min_turnover_24h_usd;
  const c_turn24 = ramp(m.turnover_24h, minTurn * 0.5, minTurn * 4);
  const c_turn7 = ramp(m.turnover_7d_median, thresholds.min_turnover_7d_median_usd * 0.5, thresholds.min_turnover_7d_median_usd * 4);
  const c_turnover = m.turnover_7d_median != null
    ? c_turn24 * 0.4 + c_turn7 * 0.6
    : c_turn24;
  const c_oi = ramp(m.open_interest_value, thresholds.min_open_interest_value_usd * 0.5, thresholds.min_open_interest_value_usd * 4);
  const c_spread = rampInv(m.spread_bps, 1, thresholds.max_spread_bps);
  const c_age = ramp(m.listing_age_days, thresholds.min_listing_age_days * 0.5, thresholds.min_listing_age_days * 4);
  const c_wick = computeWickComponent(m, thresholds);
  const c_funding = rampInv(
    m.funding_rate != null ? Math.abs(m.funding_rate) : null,
    0.0001,
    thresholds.max_funding_abs,
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
    c_rank * weights.rank +
    c_turnover * weights.turnover +
    c_oi * weights.open_interest +
    c_spread * weights.depth_slippage +
    c_age * weights.listing_age +
    c_wick * weights.wick_volatility +
    c_funding * weights.funding_normality;

  const totalWeight =
    weights.rank + weights.turnover + weights.open_interest +
    weights.depth_slippage + weights.listing_age + weights.wick_volatility + weights.funding_normality;

  const score = totalWeight > 0 ? weightedScore / totalWeight : 0;

  let status: 'approved' | 'watchlist' | 'rejected';
  if (kills.length > 0) {
    status = 'rejected';
  } else if (score >= thresholds.approved_min_score) {
    status = 'approved';
  } else if (score >= thresholds.watchlist_min_score) {
    status = 'watchlist';
  } else {
    status = 'rejected';
  }

  return {
    score: Math.round(score * 10) / 10,
    status,
    components,
    kill_rules_triggered: kills,
    wick_risk_score: m.max_1h_drop_pct != null || m.extreme_wick_count != null
      ? Math.round((100 - c_wick) * 10) / 10
      : null,
  };
}

function computeWickComponent(m: SymbolMetrics, thresholds: AdmissionThresholds): number {
  // Combine max 1h drop and extreme wick count.
  if (m.max_1h_drop_pct == null && m.extreme_wick_count == null) return 50; // unknown
  const dropComp = rampInv(m.max_1h_drop_pct, 5, thresholds.max_1h_drop_pct_30d);
  const wickComp = m.extreme_wick_count != null
    ? rampInv(m.extreme_wick_count, 0, 10)
    : 50;
  return dropComp * 0.7 + wickComp * 0.3;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
