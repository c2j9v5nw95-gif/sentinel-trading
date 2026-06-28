/**
 * Calibration Score v1 — heuristic weighted-kNN over stable profile features.
 *
 * Phase 0 update (Label Quality / Review):
 *   - Adds `no_trades` label for backtests with zero trades. By default this
 *     label is EXCLUDED from kNN training (handled by callers via
 *     `calibration_exclude_no_trades`).
 *   - `autoSuggestLabel` now returns a structured diagnosis:
 *       { label, reason, confidence, quality_score,
 *         reason_codes, positive_drivers, negative_drivers,
 *         safety_overrides, summary, config_version }
 *   - Negative net profit, PF < 1.0 and extreme leverage-adjusted drawdown
 *     are hard safety overrides → `rejected_backtest`.
 *   - Drawdown control prefers normalized/leverage-aware ratios with
 *     guardrails (no divide-by-zero, capped extreme ratios).
 */

export type BacktestLabel =
  | 'no_trades'
  | 'rejected_backtest'
  | 'marginal'
  | 'profitable'
  | 'profitable_plus';

/** Score used by kNN. `no_trades` is excluded from training by default. */
export const LABEL_SCORE: Record<BacktestLabel, number> = {
  no_trades: 0,
  rejected_backtest: 0,
  marginal: 40,
  profitable: 75,
  profitable_plus: 95,
};

export const LABEL_FIT_MULTIPLIER: Record<BacktestLabel, number> = {
  no_trades: 1.0, // neutral; should never be a dominant neighbor
  rejected_backtest: 0.6,
  marginal: 0.85,
  profitable: 1.05,
  profitable_plus: 1.2,
};

export const LABEL_CONFIG_VERSION = 'v2-phase0';

export const FEATURE_WEIGHTS: Record<string, number> = {
  robustness: 3.0,
  historical_trend_quality: 3.0,
  htq_persistence: 1.5,
  htq_mtf_alignment: 1.2,
  htq_smoothness_efficiency: 1.2,
  htq_flip_frequency: 1.2,
  htq_wick_penalty: 0.8,
  htq_tradeability_5m: 0.8,
  liquidity_24h_log: 1.5,
  liquidity_7d_log: 1.2,
  open_interest_log: 1.0,
  spread_bps: 0.8,
  listing_age_log: 0.6,
  current_momentum: 0.2,
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

export function extractFeatures(snap: ScreenerSnapshot): Record<string, number | null> {
  const c = snap.htq_components ?? {};
  return {
    robustness: numOrNull(snap.robustness),
    historical_trend_quality: numOrNull(snap.historical_trend_quality),
    htq_persistence: numOrNull(c.persistence),
    htq_mtf_alignment: numOrNull(c.mtf_alignment),
    htq_smoothness_efficiency: numOrNull(c.smoothness_efficiency),
    htq_flip_frequency:
      c.flip_frequency == null ? null : 100 - clamp01to100(numOrNull(c.flip_frequency) ?? 50),
    htq_wick_penalty: numOrNull(c.wick_penalty),
    htq_tradeability_5m: numOrNull(c.tradeability_5m),
    liquidity_24h_log: safeLog(snap.turnover_24h),
    liquidity_7d_log: safeLog(snap.turnover_7d_median),
    open_interest_log: safeLog(snap.open_interest_value),
    spread_bps: snap.spread_bps == null ? null : -1 * snap.spread_bps,
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
    if (vals.length === 0) { out[k] = 0; continue; }
    vals.sort((a, b) => a - b);
    out[k] = vals[Math.floor(vals.length / 2)];
  }
  return out;
}

export function computeFeatureStds(
  observations: Array<Record<string, number | null>>,
  medians: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(FEATURE_WEIGHTS)) {
    const m = medians[k];
    let ss = 0; let n = 0;
    for (const o of observations) {
      const v = o[k];
      if (v != null && Number.isFinite(v)) { ss += (v - m) ** 2; n++; }
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
  score: number;
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
  inclusion_radius?: number;
};

const DEFAULT_RADIUS = 3.5;

export function calibrateCandidate(
  candidateFeatures: Record<string, number | null>,
  observations: Observation[],
  medians: Record<string, number>,
  stds: Record<string, number>,
  cfg: CalibrationConfig,
): CalibrationResult | null {
  if (observations.length === 0) return null;
  const radius = cfg.inclusion_radius ?? DEFAULT_RADIUS;

  const candZ: Record<string, number> = {};
  for (const k of Object.keys(FEATURE_WEIGHTS)) {
    const raw = candidateFeatures[k];
    const v = raw == null || !Number.isFinite(raw) ? medians[k] : raw;
    candZ[k] = (v - medians[k]) / stds[k];
  }

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
    const similarity = (1 / (1 + distance)) * decay;
    return { obs: o, distance, decay, similarity };
  });

  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, Math.max(cfg.k, 1));

  let num = 0; let den = 0;
  const labelCounts: Record<BacktestLabel, number> = {
    no_trades: 0,
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

  let dominant: BacktestLabel | null = null;
  let max = -1;
  for (const lbl of Object.keys(labelCounts) as BacktestLabel[]) {
    if (labelCounts[lbl] > max) { max = labelCounts[lbl]; dominant = lbl; }
  }
  const fit_multiplier = dominant ? LABEL_FIT_MULTIPLIER[dominant] : 1;

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

// ─────────────────────────────────────────────────────────────────────────
// Auto-classification (Phase 0)
// ─────────────────────────────────────────────────────────────────────────

export type ClassificationThresholds = {
  min_trades: number;
  marginal_min_profit_factor: number;
  profitable_min_profit_factor: number;
  profitable_plus_min_profit_factor: number;
  profitable_min_normalized_net_profit_pct: number;
  profitable_plus_min_normalized_net_profit_pct: number;
  max_leverage_adjusted_drawdown_profitable: number;
  max_leverage_adjusted_drawdown_profitable_plus: number;
};

export const DEFAULT_CLASSIFICATION_THRESHOLDS: ClassificationThresholds = {
  min_trades: 20,
  marginal_min_profit_factor: 1.05,
  profitable_min_profit_factor: 1.2,
  profitable_plus_min_profit_factor: 1.5,
  profitable_min_normalized_net_profit_pct: 20,
  profitable_plus_min_normalized_net_profit_pct: 40,
  max_leverage_adjusted_drawdown_profitable: 30,
  max_leverage_adjusted_drawdown_profitable_plus: 25,
};

export type AutoSuggestInput = {
  net_profit_pct?: number | null;
  max_drawdown_pct?: number | null;
  profit_factor?: number | null;
  win_rate_pct?: number | null;
  num_trades?: number | null;
  normalized_net_profit_pct?: number | null;
  normalized_drawdown_pct?: number | null;
  leverage_adjusted_net_profit_pct?: number | null;
  leverage_adjusted_drawdown_pct?: number | null;
};

export type AutoSuggestResult = {
  label: BacktestLabel;
  reason: string;
  confidence: 'low' | 'normal';
  /** 0–100 backtest quality score (independent of label). */
  quality_score: number;
  reason_codes: string[];
  positive_drivers: Record<string, number | string>;
  negative_drivers: Record<string, number | string>;
  safety_overrides: string[];
  summary: string;
  config_version: string;
};

/** Drawdown-control ratio (net / DD), prefers normalized/leverage-aware values,
 *  with guardrails: returns null when DD is missing or zero; clamps extremes. */
function drawdownControlRatio(input: AutoSuggestInput): { ratio: number | null; source: string } {
  const pairs: Array<[number | null | undefined, number | null | undefined, string]> = [
    [input.leverage_adjusted_net_profit_pct, input.leverage_adjusted_drawdown_pct, 'leverage_adjusted'],
    [input.normalized_net_profit_pct, input.normalized_drawdown_pct, 'normalized'],
    [input.net_profit_pct, input.max_drawdown_pct, 'account'],
  ];
  for (const [n, d, src] of pairs) {
    if (n == null || d == null) continue;
    const dd = Math.abs(d);
    if (dd < 0.5) continue; // guardrail: avoid divide-by-near-zero
    const r = n / dd;
    return { ratio: Math.max(-10, Math.min(10, r)), source: src };
  }
  return { ratio: null, source: 'unknown' };
}

export function computeBacktestQualityScore(input: AutoSuggestInput): {
  score: number;
  components: Record<string, number>;
} {
  const trades = input.num_trades ?? 0;
  if (trades === 0) return { score: 0, components: { no_trades: 0 } };

  const components: Record<string, number> = {};
  // Profitability (0–35)
  const np = input.net_profit_pct;
  components.profitability = np == null ? 10 : Math.max(0, Math.min(35, 17 + np * 0.6));
  // Profit factor (0–20)
  const pf = input.profit_factor;
  components.profit_factor = pf == null ? 5 : Math.max(0, Math.min(20, (pf - 1) * 20));
  // Drawdown control (0–20)
  const { ratio } = drawdownControlRatio(input);
  components.drawdown_control = ratio == null ? 8 : Math.max(0, Math.min(20, ratio * 8 + 8));
  // Win rate (0–10)
  const wr = input.win_rate_pct;
  components.win_rate = wr == null ? 4 : Math.max(0, Math.min(10, (wr - 30) * 0.3));
  // Sample size (0–15)
  const tradeBoost = Math.min(15, Math.log10(Math.max(trades, 1) + 1) * 12);
  components.sample_size = tradeBoost;

  const total = Object.values(components).reduce((a, b) => a + b, 0);
  return { score: Math.max(0, Math.min(100, total)), components };
}

/**
 * Auto-suggest a label with full diagnostics. Always a SUGGESTION.
 *
 * Priority:
 *   1. num_trades == 0                 → no_trades  (separate from rejected)
 *   2. net_profit_pct < 0              → rejected_backtest (safety override)
 *   3. profit_factor < 1.0             → rejected_backtest (safety override)
 *   4. extreme leverage-adj drawdown   → rejected/marginal cap (safety override)
 *   5. Profitable+ gates               → profitable_plus
 *   6. Profitable gates                → profitable
 *   7. Otherwise                        → marginal (low confidence if trades < min)
 */
export function autoSuggestLabel(
  input: AutoSuggestInput,
  thresholds: ClassificationThresholds = DEFAULT_CLASSIFICATION_THRESHOLDS,
): AutoSuggestResult {
  const np = input.net_profit_pct ?? null;
  const dd = input.max_drawdown_pct == null ? null : Math.abs(input.max_drawdown_pct);
  const pf = input.profit_factor ?? null;
  const wr = input.win_rate_pct ?? null;
  const trades = input.num_trades ?? 0;
  const nNet = input.normalized_net_profit_pct ?? null;
  const nDd = input.normalized_drawdown_pct == null ? null : Math.abs(input.normalized_drawdown_pct);
  const lNet = input.leverage_adjusted_net_profit_pct ?? null;
  const lDd =
    input.leverage_adjusted_drawdown_pct == null ? null : Math.abs(input.leverage_adjusted_drawdown_pct);

  const { score: qScore } = computeBacktestQualityScore(input);
  const reason_codes: string[] = [];
  const positive_drivers: Record<string, number | string> = {};
  const negative_drivers: Record<string, number | string> = {};
  const safety_overrides: string[] = [];

  // 1) No-trades — separate label
  if (trades === 0) {
    reason_codes.push('no_trades');
    return {
      label: 'no_trades',
      reason: 'No trades during test period — strategy found no valid setup.',
      confidence: 'normal',
      quality_score: 0,
      reason_codes,
      positive_drivers,
      negative_drivers,
      safety_overrides,
      summary: 'No trades during test period — no setup found.',
      config_version: LABEL_CONFIG_VERSION,
    };
  }

  // Collect drivers for diagnostics
  if (pf != null) (pf >= 1 ? positive_drivers : negative_drivers).profit_factor = Number(pf.toFixed(2));
  if (np != null) (np >= 0 ? positive_drivers : negative_drivers).net_profit_pct = Number(np.toFixed(2));
  if (nNet != null) (nNet >= 0 ? positive_drivers : negative_drivers).normalized_net_profit_pct = Number(nNet.toFixed(2));
  if (lDd != null) negative_drivers.leverage_adjusted_drawdown_pct = Number(lDd.toFixed(2));
  if (wr != null) (wr >= 50 ? positive_drivers : negative_drivers).win_rate_pct = Number(wr.toFixed(1));

  // 2-4) Safety overrides → rejected
  if (np != null && np < 0) {
    safety_overrides.push('negative_net_profit');
    reason_codes.push('negative_net_profit');
  }
  if (pf != null && pf < 1.0) {
    safety_overrides.push('profit_factor_below_1');
    reason_codes.push('profit_factor_below_1');
  }
  if (lDd != null && lDd > 50) {
    safety_overrides.push('extreme_leverage_adjusted_drawdown');
    reason_codes.push('extreme_leverage_adjusted_drawdown');
  }
  if (safety_overrides.length > 0) {
    const why = np != null && np < 0
      ? `Net profit ${np.toFixed(2)}% < 0`
      : pf != null && pf < 1
      ? `Profit factor ${pf.toFixed(2)} < 1.0`
      : `Leverage-adjusted DD ${lDd?.toFixed(1)}% > 50%`;
    return {
      label: 'rejected_backtest',
      reason: `${why} (safety override).`,
      confidence: trades < thresholds.min_trades ? 'low' : 'normal',
      quality_score: qScore,
      reason_codes,
      positive_drivers,
      negative_drivers,
      safety_overrides,
      summary: `Rejected by safety override: ${safety_overrides.join(', ')}.`,
      config_version: LABEL_CONFIG_VERSION,
    };
  }

  // Low trade count handling — never auto-rejects on its own; confidence drops
  const lowSample = trades < thresholds.min_trades;
  if (lowSample) reason_codes.push('low_trade_count');

  // 5) Profitable+
  const { ratio: ddCtrlRatio, source: ddCtrlSrc } = drawdownControlRatio(input);
  if (ddCtrlRatio != null) {
    (ddCtrlRatio >= 1 ? positive_drivers : negative_drivers)[`drawdown_control_${ddCtrlSrc}`] =
      Number(ddCtrlRatio.toFixed(2));
  }

  if (
    pf != null && pf >= thresholds.profitable_plus_min_profit_factor &&
    nNet != null && nNet >= thresholds.profitable_plus_min_normalized_net_profit_pct &&
    (lDd == null || lDd <= thresholds.max_leverage_adjusted_drawdown_profitable_plus) &&
    (lNet == null || lNet > 0) &&
    (ddCtrlRatio == null || ddCtrlRatio >= 1.5)
  ) {
    reason_codes.push('profitable_plus_gates_met');
    return {
      label: 'profitable_plus',
      reason: `PF ${pf.toFixed(2)}, normalized net ${nNet.toFixed(1)}%, leverage-adj DD ${lDd != null ? lDd.toFixed(1) + '%' : '—'}.`,
      confidence: lowSample ? 'low' : 'normal',
      quality_score: qScore,
      reason_codes,
      positive_drivers,
      negative_drivers,
      safety_overrides,
      summary: `Profitable+ gates met${lowSample ? ` — confidence reduced (${trades} trades).` : '.'}`,
      config_version: LABEL_CONFIG_VERSION,
    };
  }

  // 6) Profitable
  if (
    pf != null && pf >= thresholds.profitable_min_profit_factor &&
    nNet != null && nNet >= thresholds.profitable_min_normalized_net_profit_pct &&
    (lDd == null || lDd <= thresholds.max_leverage_adjusted_drawdown_profitable) &&
    (np == null || np >= 0)
  ) {
    reason_codes.push('profitable_gates_met');
    return {
      label: 'profitable',
      reason: `PF ${pf.toFixed(2)}, normalized net ${nNet.toFixed(1)}% meets Profitable gates.`,
      confidence: lowSample ? 'low' : 'normal',
      quality_score: qScore,
      reason_codes,
      positive_drivers,
      negative_drivers,
      safety_overrides,
      summary: `Profitable gates met${lowSample ? ` — confidence reduced (${trades} trades).` : '.'}`,
      config_version: LABEL_CONFIG_VERSION,
    };
  }

  // PF below marginal floor → rejected
  if (pf != null && pf < thresholds.marginal_min_profit_factor) {
    reason_codes.push('profit_factor_below_marginal_floor');
    return {
      label: 'rejected_backtest',
      reason: `Profit factor ${pf.toFixed(2)} < ${thresholds.marginal_min_profit_factor}.`,
      confidence: lowSample ? 'low' : 'normal',
      quality_score: qScore,
      reason_codes,
      positive_drivers,
      negative_drivers,
      safety_overrides,
      summary: `Profit factor below marginal floor.`,
      config_version: LABEL_CONFIG_VERSION,
    };
  }

  // 7) Marginal (weak positive)
  reason_codes.push('marginal_weak_positive');
  const bits: string[] = [];
  if (pf != null) bits.push(`PF ${pf.toFixed(2)}`);
  if (nNet != null) bits.push(`norm net ${nNet.toFixed(1)}%`);
  if (lDd != null) bits.push(`lev-adj DD ${lDd.toFixed(1)}%`);
  return {
    label: 'marginal',
    reason: `Doesn't meet Profitable gates (${bits.join(', ') || 'weak metrics'}).`,
    confidence: lowSample ? 'low' : 'normal',
    quality_score: qScore,
    reason_codes,
    positive_drivers,
    negative_drivers,
    safety_overrides,
    summary: `Marginal — weak positive metrics${lowSample ? `, low trade count (${trades}).` : '.'}`,
    config_version: LABEL_CONFIG_VERSION,
  };
}

/** Back-compat shim: legacy callers that just want a label. */
export function autoSuggestLabelOnly(input: AutoSuggestInput): BacktestLabel {
  return autoSuggestLabel(input).label;
}

/**
 * Detects rows that should be flagged for review when the suggested label
 * disagrees with the confirmed label (or shows red flags vs. the chosen label).
 * Returns null when no review is needed.
 */
export function detectNeedsReview(
  confirmedLabel: BacktestLabel,
  suggestion: AutoSuggestResult,
): { needs_review: boolean; reason: string | null } {
  if (suggestion.label !== confirmedLabel) {
    return {
      needs_review: true,
      reason: `Suggested label "${suggestion.label}" differs from confirmed "${confirmedLabel}".`,
    };
  }
  // Confirmed marginal/rejected but drivers look positive → flag for review
  if ((confirmedLabel === 'marginal' || confirmedLabel === 'rejected_backtest') &&
      Object.keys(suggestion.positive_drivers).length >= 3 &&
      suggestion.safety_overrides.length === 0) {
    return {
      needs_review: true,
      reason: 'Confirmed label may be too strict — multiple positive drivers and no safety overrides.',
    };
  }
  return { needs_review: false, reason: null };
}
