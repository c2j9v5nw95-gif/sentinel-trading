/**
 * Calibration Score v1 — heuristic weighted-kNN over stable profile features.
 *
 * The Score answers: "How much does this admission candidate resemble PAST
 * observations that were Profitable / Profitable+ in real backtests?"
 *
 * Design notes:
 * - Feature space: stable profile traits (Robustness, HTQ + components, liquidity,
 *   listing age). Current Momentum is included with very low weight by design.
 * - Distance: weighted Euclidean on z-normalized features. Missing values are
 *   imputed with the global feature median (so a missing field does not dominate).
 * - Time-decay: observation weight = 0.5 ^ (ageDays / halfLifeDays).
 * - Score: weighted mean of label scores (rejected=0, marginal=40, profitable=75,
 *   profitable_plus=95) over the top-k nearest neighbors, then normalized to 0–100.
 * - Confidence: Low / Medium / High based on neighbor count within an inclusion
 *   radius (>= calibration_min_neighbors_medium / _high from app_settings).
 */

export type BacktestLabel =
  | 'rejected_backtest'
  | 'marginal'
  | 'profitable'
  | 'profitable_plus';

export const LABEL_SCORE: Record<BacktestLabel, number> = {
  rejected_backtest: 0,
  marginal: 40,
  profitable: 75,
  profitable_plus: 95,
};

export const LABEL_FIT_MULTIPLIER: Record<BacktestLabel, number> = {
  // Used for "calibrated_strategy_fit": shifts base strategy_fit_score
  // up/down based on neighbor labels (range roughly 0.6 - 1.2).
  rejected_backtest: 0.6,
  marginal: 0.85,
  profitable: 1.05,
  profitable_plus: 1.2,
};

/**
 * Features pulled from screener_snapshot for kNN distance.
 * Weights are deliberate — the user asked that current_momentum NOT drive
 * calibration in v1 (it is informational only). Stable, profile-style traits
 * dominate.
 */
export const FEATURE_WEIGHTS: Record<string, number> = {
  robustness: 3.0,
  historical_trend_quality: 3.0,
  htq_persistence: 1.5,
  htq_mtf_alignment: 1.2,
  htq_smoothness_efficiency: 1.2,
  htq_flip_frequency: 1.2, // higher flips = worse; we transform below
  htq_wick_penalty: 0.8,
  htq_tradeability_5m: 0.8,
  liquidity_24h_log: 1.5,
  liquidity_7d_log: 1.2,
  open_interest_log: 1.0,
  spread_bps: 0.8, // lower better
  listing_age_log: 0.6,
  current_momentum: 0.2, // intentionally tiny
};

export type ScreenerSnapshot = {
  robustness?: number | null;
  historical_trend_quality?: number | null;
  htq_components?: Record<string, number | null | undefined> | null;
  current_momentum_score?: number | null;
  turnover_24h?: number | null;
  turnover_7d_median?: number | null;
  open_interest_value?: number | null;
  spread_bps?: number | null;
  listing_age_days?: number | null;
};

function safeLog(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return Math.log10(n);
}

/** Extract feature vector. Returns nullable map; nulls handled in distance. */
export function extractFeatures(snap: ScreenerSnapshot): Record<string, number | null> {
  const c = snap.htq_components ?? {};
  return {
    robustness: numOrNull(snap.robustness),
    historical_trend_quality: numOrNull(snap.historical_trend_quality),
    htq_persistence: numOrNull(c.persistence),
    htq_mtf_alignment: numOrNull(c.mtf_alignment),
    htq_smoothness_efficiency: numOrNull(c.smoothness_efficiency),
    // flip_frequency: lower (≤2 flips/day) = better; we invert to align with "higher = better"
    htq_flip_frequency:
      c.flip_frequency == null ? null : 100 - clamp01to100(numOrNull(c.flip_frequency) ?? 50),
    htq_wick_penalty: numOrNull(c.wick_penalty),
    htq_tradeability_5m: numOrNull(c.tradeability_5m),
    liquidity_24h_log: safeLog(snap.turnover_24h),
    liquidity_7d_log: safeLog(snap.turnover_7d_median),
    open_interest_log: safeLog(snap.open_interest_value),
    spread_bps: snap.spread_bps == null ? null : -1 * snap.spread_bps, // lower spread = higher score
    listing_age_log: safeLog(snap.listing_age_days),
    current_momentum: numOrNull(snap.current_momentum_score),
  };
}

function numOrNull(n: unknown): number | null {
  if (n == null) return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}
function clamp01to100(n: number | null): number {
  if (n == null) return 50;
  return Math.max(0, Math.min(100, n));
}

/** Per-feature median across observations, used as imputation fallback. */
export function computeFeatureMedians(
  observations: Array<Record<string, number | null>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const keys = Object.keys(FEATURE_WEIGHTS);
  for (const k of keys) {
    const vals: number[] = [];
    for (const o of observations) {
      const v = o[k];
      if (v != null && Number.isFinite(v)) vals.push(v);
    }
    if (vals.length === 0) {
      out[k] = 0;
      continue;
    }
    vals.sort((a, b) => a - b);
    out[k] = vals[Math.floor(vals.length / 2)];
  }
  return out;
}

/** Per-feature stdev across observations. Floor at 1 to avoid divide-by-zero. */
export function computeFeatureStds(
  observations: Array<Record<string, number | null>>,
  medians: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(FEATURE_WEIGHTS)) {
    const m = medians[k];
    let ss = 0;
    let n = 0;
    for (const o of observations) {
      const v = o[k];
      if (v != null && Number.isFinite(v)) {
        ss += (v - m) ** 2;
        n++;
      }
    }
    const std = n > 1 ? Math.sqrt(ss / (n - 1)) : 1;
    out[k] = std > 1e-6 ? std : 1;
  }
  return out;
}

export type Observation = {
  id: string;
  symbol: string;
  test_date: string;
  label: BacktestLabel;
  features: Record<string, number | null>;
  age_days: number;
};

export type CalibrationResult = {
  score: number; // 0..100
  confidence: 'low' | 'medium' | 'high';
  label: BacktestLabel | null;
  fit_multiplier: number;
  neighbors: Array<{
    id: string;
    symbol: string;
    test_date: string;
    label: BacktestLabel;
    distance: number;
    weight: number;
  }>;
  observations_used: number;
};

export type CalibrationConfig = {
  k: number;
  half_life_days: number;
  min_neighbors_medium: number;
  min_neighbors_high: number;
  /** Inclusion radius (in normalized distance units). Beyond this a neighbor
   *  is still kept but counted toward "tail" rather than "high confidence". */
  inclusion_radius?: number;
};

const DEFAULT_RADIUS = 3.5;

/**
 * Score a single candidate against the observation set.
 *
 * Returns null only when `observations` is empty (caller decides what to render).
 */
export function calibrateCandidate(
  candidateFeatures: Record<string, number | null>,
  observations: Observation[],
  medians: Record<string, number>,
  stds: Record<string, number>,
  cfg: CalibrationConfig,
): CalibrationResult | null {
  if (observations.length === 0) return null;
  const radius = cfg.inclusion_radius ?? DEFAULT_RADIUS;

  // Precompute candidate z-vector
  const candZ: Record<string, number> = {};
  for (const k of Object.keys(FEATURE_WEIGHTS)) {
    const raw = candidateFeatures[k];
    const v = raw == null || !Number.isFinite(raw) ? medians[k] : raw;
    candZ[k] = (v - medians[k]) / stds[k];
  }

  // Compute weighted distance to each observation
  const scored = observations.map((o) => {
    let d2 = 0;
    for (const k of Object.keys(FEATURE_WEIGHTS)) {
      const w = FEATURE_WEIGHTS[k];
      const raw = o.features[k];
      const v = raw == null || !Number.isFinite(raw) ? medians[k] : raw;
      const z = (v - medians[k]) / stds[k];
      const diff = candZ[k] - z;
      d2 += w * diff * diff;
    }
    const distance = Math.sqrt(d2);
    const decay = Math.pow(0.5, o.age_days / Math.max(cfg.half_life_days, 1));
    // similarity in (0,1], stronger when close & recent
    const similarity = (1 / (1 + distance)) * decay;
    return { obs: o, distance, decay, similarity };
  });

  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, Math.max(cfg.k, 1));

  // Weighted score = sum(similarity * labelScore) / sum(similarity)
  let num = 0;
  let den = 0;
  const labelCounts: Record<BacktestLabel, number> = {
    rejected_backtest: 0,
    marginal: 0,
    profitable: 0,
    profitable_plus: 0,
  };
  for (const t of top) {
    num += t.similarity * LABEL_SCORE[t.obs.label];
    den += t.similarity;
    labelCounts[t.obs.label] += t.similarity;
  }
  const score = den > 0 ? num / den : 0;

  // Dominant label = highest similarity-weighted vote
  let dominant: BacktestLabel | null = null;
  let max = -1;
  for (const lbl of Object.keys(labelCounts) as BacktestLabel[]) {
    if (labelCounts[lbl] > max) {
      max = labelCounts[lbl];
      dominant = lbl;
    }
  }
  const fit_multiplier = dominant ? LABEL_FIT_MULTIPLIER[dominant] : 1;

  // Confidence: number of neighbors within inclusion radius
  const inRadius = scored.filter((s) => s.distance <= radius).length;
  let confidence: 'low' | 'medium' | 'high' = 'low';
  if (inRadius >= cfg.min_neighbors_high) confidence = 'high';
  else if (inRadius >= cfg.min_neighbors_medium) confidence = 'medium';

  return {
    score: Math.max(0, Math.min(100, score)),
    confidence,
    label: dominant,
    fit_multiplier,
    neighbors: top.map((t) => ({
      id: t.obs.id,
      symbol: t.obs.symbol,
      test_date: t.obs.test_date,
      label: t.obs.label,
      distance: Number(t.distance.toFixed(3)),
      weight: Number(t.similarity.toFixed(4)),
    })),
    observations_used: observations.length,
  };
}

/** Auto-suggest a label from raw backtest metrics. Caller can override. */
export function autoSuggestLabel(input: {
  net_profit_pct?: number | null;
  max_drawdown_pct?: number | null;
  profit_factor?: number | null;
  win_rate_pct?: number | null;
  num_trades?: number | null;
}): BacktestLabel {
  const pnl = input.net_profit_pct ?? 0;
  const dd = Math.abs(input.max_drawdown_pct ?? 0);
  const pf = input.profit_factor ?? 0;
  const trades = input.num_trades ?? 0;

  // Rejected if losing, too-few trades, or PF < 1
  if (pnl <= 0 || pf < 1 || trades < 10) return 'rejected_backtest';
  // Profitable+ requires strong PF, healthy PnL, controlled DD
  if (pf >= 1.5 && pnl >= 15 && dd <= 15) return 'profitable_plus';
  if (pf >= 1.2 && pnl >= 5 && dd <= 25) return 'profitable';
  return 'marginal';
}
