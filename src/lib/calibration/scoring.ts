/**
 * Calibration Score — strategy-aware revision (v3-strategy-aware).
 *
 * Key changes vs v2-phase0:
 *   - Sample buckets reflect the selective live strategy:
 *       0          → no_trades       (excluded)
 *       1–3        → very_low_sample (weight 0.15)
 *       4–7        → low_sample      (weight 0.35)
 *       8–12       → acceptable      (weight 0.75)
 *       13–19      → good            (weight 0.90)
 *       20+        → strong          (weight 1.00)
 *     The old hard 20-trade floor that penalised valid 15–17 trade backtests
 *     is gone.
 *   - autoSuggestLabel uses these buckets so e.g. 15 trades / PF 8.7 / WR 80
 *     can become `profitable` (or `profitable_plus` when the stricter
 *     normalized-net / drawdown gates are met).
 *   - Profitable+ is intentionally strict: trades ≥ 12, PF ≥ 3.0, WR ≥ 70,
 *     meaningful normalized net, controlled drawdown, no safety override.
 *   - calibrateCandidate uses `backtest_quality_score` as the per-neighbour
 *     outcome (weighted by similarity · time_decay · sample_confidence_weight).
 *     Falls back to LABEL_SCORE when quality_score is missing and surfaces the
 *     fallback in the neighbour breakdown.
 *
 * Nothing here touches execution, risk, dispatcher or live orders.
 */

export type BacktestLabel =
  | 'no_trades'
  | 'rejected_backtest'
  | 'marginal'
  | 'profitable'
  | 'profitable_plus';

export type SampleBucket =
  | 'no_trades'
  | 'very_low_sample'
  | 'low_sample'
  | 'acceptable_sample'
  | 'good_sample'
  | 'strong_sample';

/** Legacy label → outcome score, used as a FALLBACK when quality_score is missing. */
export const LABEL_SCORE: Record<BacktestLabel, number> = {
  no_trades: 0,
  rejected_backtest: 0,
  marginal: 40,
  profitable: 75,
  profitable_plus: 95,
};

export const LABEL_FIT_MULTIPLIER: Record<BacktestLabel, number> = {
  no_trades: 1.0,
  rejected_backtest: 0.6,
  marginal: 0.85,
  profitable: 1.05,
  profitable_plus: 1.2,
};

export const LABEL_CONFIG_VERSION = 'v3-strategy-aware';

// ─── Sample buckets ────────────────────────────────────────────────────────

export function sampleBucketFor(numTrades: number | null | undefined): SampleBucket {
  const t = numTrades ?? 0;
  if (t <= 0) return 'no_trades';
  if (t <= 3) return 'very_low_sample';
  if (t <= 7) return 'low_sample';
  if (t <= 12) return 'acceptable_sample';
  if (t <= 19) return 'good_sample';
  return 'strong_sample';
}

export const SAMPLE_CONFIDENCE_WEIGHT: Record<SampleBucket, number> = {
  no_trades: 0,
  very_low_sample: 0.15,
  low_sample: 0.35,
  acceptable_sample: 0.75,
  good_sample: 0.9,
  strong_sample: 1.0,
};

export function sampleConfidenceWeight(numTrades: number | null | undefined): number {
  return SAMPLE_CONFIDENCE_WEIGHT[sampleBucketFor(numTrades)];
}

export const SAMPLE_BUCKET_LABEL: Record<SampleBucket, string> = {
  no_trades: 'No Trades',
  very_low_sample: 'Very Low Sample (1–3)',
  low_sample: 'Low Sample (4–7)',
  acceptable_sample: 'Acceptable (8–12)',
  good_sample: 'Good (13–19)',
  strong_sample: 'Strong (20+)',
};

// ─── Feature extraction (unchanged) ────────────────────────────────────────

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

// ─── kNN ───────────────────────────────────────────────────────────────────

export type Observation = {
  id: string;
  symbol: string;
  test_date: string;
  label: BacktestLabel;
  label_source?: 'auto' | 'manual_override' | string | null;
  features: Record<string, number | null>;
  age_days: number;
  /** New: quality outcome (0–100). Null → fallback to LABEL_SCORE. */
  quality_score?: number | null;
  /** New: persisted sample confidence multiplier 0..1. */
  sample_confidence_weight?: number | null;
  /** New: persisted sample bucket. */
  sample_bucket?: SampleBucket | null;
  num_trades?: number | null;
};

export type NeighborBreakdown = {
  id: string;
  symbol: string;
  test_date: string;
  label: BacktestLabel;
  label_source: string | null;
  num_trades: number | null;
  sample_bucket: SampleBucket | null;
  distance: number;
  /** time decay (0–1) */
  time_decay: number;
  /** raw 1/(1+dist) similarity */
  similarity: number;
  /** sample_confidence_weight applied */
  sample_confidence_weight: number;
  /** outcome used (quality_score or LABEL_SCORE fallback) */
  outcome: number;
  /** true when quality_score was missing and label-score fallback used */
  used_fallback: boolean;
  /** final weight in the weighted average (similarity*decay*sample_w) */
  final_weight: number;
  /** outcome × final_weight (pre-normalisation) */
  contribution: number;
  note?: string;
};

export type CalibrationResult = {
  score: number;
  confidence: 'low' | 'medium' | 'high';
  label: BacktestLabel | null;
  fit_multiplier: number;
  neighbors: NeighborBreakdown[];
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
    const baseSim = 1 / (1 + distance);
    const sampleW =
      o.sample_confidence_weight != null
        ? Math.max(0, Math.min(1, o.sample_confidence_weight))
        : sampleConfidenceWeight(o.num_trades);
    const finalWeight = baseSim * decay * sampleW;

    const usedFallback = o.quality_score == null || !Number.isFinite(o.quality_score);
    const outcome = usedFallback ? LABEL_SCORE[o.label] : Number(o.quality_score);

    return {
      obs: o,
      distance,
      decay,
      baseSim,
      sampleW,
      finalWeight,
      outcome,
      usedFallback,
    };
  });

  // Rank by final_weight (which already folds in similarity, decay, sample).
  scored.sort((a, b) => b.finalWeight - a.finalWeight);
  const top = scored.slice(0, Math.max(cfg.k, 1));

  let num = 0;
  let den = 0;
  const labelCounts: Record<BacktestLabel, number> = {
    no_trades: 0,
    rejected_backtest: 0,
    marginal: 0,
    profitable: 0,
    profitable_plus: 0,
  };
  for (const t of top) {
    num += t.finalWeight * t.outcome;
    den += t.finalWeight;
    labelCounts[t.obs.label] += t.finalWeight;
  }
  const score = den > 0 ? num / den : 0;

  let dominant: BacktestLabel | null = null;
  let max = -1;
  for (const lbl of Object.keys(labelCounts) as BacktestLabel[]) {
    if (labelCounts[lbl] > max) { max = labelCounts[lbl]; dominant = lbl; }
  }
  const fit_multiplier = dominant ? LABEL_FIT_MULTIPLIER[dominant] : 1;

  // Confidence uses spatial neighbours (raw distance), not the sample-weighted
  // ranking — so we still penalise sparse feature regions.
  const inRadius = scored.filter((s) => s.distance <= radius).length;
  let confidence: 'low' | 'medium' | 'high' = 'low';
  if (inRadius >= cfg.min_neighbors_high) confidence = 'high';
  else if (inRadius >= cfg.min_neighbors_medium) confidence = 'medium';

  const neighbors: NeighborBreakdown[] = top.map((t) => ({
    id: t.obs.id,
    symbol: t.obs.symbol,
    test_date: t.obs.test_date,
    label: t.obs.label,
    label_source: (t.obs.label_source ?? null) as string | null,
    num_trades: t.obs.num_trades ?? null,
    sample_bucket: (t.obs.sample_bucket ?? sampleBucketFor(t.obs.num_trades)) as SampleBucket,
    distance: Number(t.distance.toFixed(3)),
    time_decay: Number(t.decay.toFixed(3)),
    similarity: Number(t.baseSim.toFixed(4)),
    sample_confidence_weight: Number(t.sampleW.toFixed(2)),
    outcome: Number(t.outcome.toFixed(1)),
    used_fallback: t.usedFallback,
    final_weight: Number(t.finalWeight.toFixed(4)),
    contribution: Number((t.finalWeight * t.outcome).toFixed(2)),
    note: t.usedFallback
      ? 'Fallback: label-based outcome because quality score is missing'
      : undefined,
  }));

  return {
    score: Math.max(0, Math.min(100, score)),
    confidence,
    label: dominant,
    fit_multiplier,
    neighbors,
    observations_used: observations.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Auto-classification (strategy-aware)
// ─────────────────────────────────────────────────────────────────────────

export type ClassificationThresholds = {
  /** Smallest sample considered "acceptable" for Profitable. Selective
   *  strategies can hit this with 8 trades. */
  profitable_min_trades: number;
  /** Profitable+ requires a noticeably larger / cleaner sample. */
  profitable_plus_min_trades: number;
  marginal_min_profit_factor: number;
  profitable_min_profit_factor: number;
  profitable_plus_min_profit_factor: number;
  profitable_min_win_rate_pct: number;
  profitable_plus_min_win_rate_pct: number;
  profitable_min_normalized_net_profit_pct: number;
  profitable_plus_min_normalized_net_profit_pct: number;
  max_leverage_adjusted_drawdown_profitable: number;
  max_leverage_adjusted_drawdown_profitable_plus: number;
  /** Required net/DD ratio for Profitable+. */
  profitable_plus_min_drawdown_control_ratio: number;
};

export const DEFAULT_CLASSIFICATION_THRESHOLDS: ClassificationThresholds = {
  profitable_min_trades: 8,
  profitable_plus_min_trades: 12,
  marginal_min_profit_factor: 1.05,
  profitable_min_profit_factor: 1.5,
  profitable_plus_min_profit_factor: 3.0,
  profitable_min_win_rate_pct: 55,
  profitable_plus_min_win_rate_pct: 70,
  profitable_min_normalized_net_profit_pct: 10,
  profitable_plus_min_normalized_net_profit_pct: 30,
  max_leverage_adjusted_drawdown_profitable: 35,
  max_leverage_adjusted_drawdown_profitable_plus: 30,
  profitable_plus_min_drawdown_control_ratio: 2.0,
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
  quality_score: number;
  reason_codes: string[];
  positive_drivers: Record<string, number | string>;
  negative_drivers: Record<string, number | string>;
  safety_overrides: string[];
  summary: string;
  /** New: classified sample bucket for this row. */
  sample_bucket: SampleBucket;
  /** New: confidence multiplier 0..1 used downstream by calibration. */
  sample_confidence_weight: number;
  config_version: string;
};

function drawdownControlRatio(input: AutoSuggestInput): { ratio: number | null; source: string } {
  const pairs: Array<[number | null | undefined, number | null | undefined, string]> = [
    [input.leverage_adjusted_net_profit_pct, input.leverage_adjusted_drawdown_pct, 'leverage_adjusted'],
    [input.normalized_net_profit_pct, input.normalized_drawdown_pct, 'normalized'],
    [input.net_profit_pct, input.max_drawdown_pct, 'account'],
  ];
  for (const [n, d, src] of pairs) {
    if (n == null || d == null) continue;
    const dd = Math.abs(d);
    if (dd < 0.5) continue;
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
  const np = input.net_profit_pct;
  components.profitability = np == null ? 10 : Math.max(0, Math.min(35, 17 + np * 0.6));
  const pf = input.profit_factor;
  components.profit_factor = pf == null ? 5 : Math.max(0, Math.min(20, (pf - 1) * 20));
  const { ratio } = drawdownControlRatio(input);
  components.drawdown_control = ratio == null ? 8 : Math.max(0, Math.min(20, ratio * 8 + 8));
  const wr = input.win_rate_pct;
  components.win_rate = wr == null ? 4 : Math.max(0, Math.min(10, (wr - 30) * 0.3));
  const tradeBoost = Math.min(15, Math.log10(Math.max(trades, 1) + 1) * 12);
  components.sample_size = tradeBoost;

  const total = Object.values(components).reduce((a, b) => a + b, 0);
  return { score: Math.max(0, Math.min(100, total)), components };
}

/**
 * Suggest a label. Always a SUGGESTION — never overrides manual confirmation.
 *
 * Priority:
 *   1. num_trades == 0                      → no_trades
 *   2. net < 0 / PF < 1 / extreme lev DD     → rejected_backtest (safety)
 *   3. Profitable+ strict gates              → profitable_plus
 *   4. Profitable gates                      → profitable
 *   5. PF below marginal floor               → rejected_backtest
 *   6. Otherwise                              → marginal
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

  const bucket = sampleBucketFor(trades);
  const sampleW = SAMPLE_CONFIDENCE_WEIGHT[bucket];
  const { score: qScore } = computeBacktestQualityScore(input);
  const reason_codes: string[] = [`sample:${bucket}`];
  const positive_drivers: Record<string, number | string> = {};
  const negative_drivers: Record<string, number | string> = {};
  const safety_overrides: string[] = [];

  // 1) No trades
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
      sample_bucket: bucket,
      sample_confidence_weight: sampleW,
      config_version: LABEL_CONFIG_VERSION,
    };
  }

  // Diagnostics
  if (pf != null) (pf >= 1 ? positive_drivers : negative_drivers).profit_factor = Number(pf.toFixed(2));
  if (np != null) (np >= 0 ? positive_drivers : negative_drivers).net_profit_pct = Number(np.toFixed(2));
  if (nNet != null) (nNet >= 0 ? positive_drivers : negative_drivers).normalized_net_profit_pct = Number(nNet.toFixed(2));
  if (lDd != null) negative_drivers.leverage_adjusted_drawdown_pct = Number(lDd.toFixed(2));
  if (wr != null) (wr >= 50 ? positive_drivers : negative_drivers).win_rate_pct = Number(wr.toFixed(1));
  positive_drivers.sample_bucket = bucket;
  positive_drivers.sample_confidence_weight = sampleW;

  // 2) Safety overrides
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
      confidence: sampleW < 0.5 ? 'low' : 'normal',
      quality_score: qScore,
      reason_codes,
      positive_drivers,
      negative_drivers,
      safety_overrides,
      summary: `Rejected by safety override: ${safety_overrides.join(', ')}.`,
      sample_bucket: bucket,
      sample_confidence_weight: sampleW,
      config_version: LABEL_CONFIG_VERSION,
    };
  }

  // Drawdown control ratio (for diagnostics + Profitable+ gate)
  const { ratio: ddCtrlRatio, source: ddCtrlSrc } = drawdownControlRatio(input);
  if (ddCtrlRatio != null) {
    (ddCtrlRatio >= 1 ? positive_drivers : negative_drivers)[`drawdown_control_${ddCtrlSrc}`] =
      Number(ddCtrlRatio.toFixed(2));
  }

  // Helper: "meaningful" normalized net check that tolerates missing data
  const normNetMeetsProfitable =
    nNet != null
      ? nNet >= thresholds.profitable_min_normalized_net_profit_pct
      : np != null && np >= 0;
  const normNetMeetsProfitablePlus =
    nNet != null
      ? nNet >= thresholds.profitable_plus_min_normalized_net_profit_pct
      : np != null && np >= 20;

  // 3) Profitable+ — strict
  const meetsPlus =
    trades >= thresholds.profitable_plus_min_trades &&
    pf != null && pf >= thresholds.profitable_plus_min_profit_factor &&
    wr != null && wr >= thresholds.profitable_plus_min_win_rate_pct &&
    normNetMeetsProfitablePlus &&
    (lDd == null || lDd <= thresholds.max_leverage_adjusted_drawdown_profitable_plus) &&
    (lNet == null || lNet > 0) &&
    (ddCtrlRatio == null || ddCtrlRatio >= thresholds.profitable_plus_min_drawdown_control_ratio);

  if (meetsPlus) {
    reason_codes.push('profitable_plus_gates_met');
    return {
      label: 'profitable_plus',
      reason: `PF ${pf!.toFixed(2)}, WR ${wr!.toFixed(0)}%, norm net ${nNet != null ? nNet.toFixed(1) + '%' : '—'}, lev-adj DD ${lDd != null ? lDd.toFixed(1) + '%' : '—'}, trades ${trades}.`,
      confidence: sampleW < 0.75 ? 'low' : 'normal',
      quality_score: qScore,
      reason_codes,
      positive_drivers,
      negative_drivers,
      safety_overrides,
      summary: `Profitable+ gates met (${SAMPLE_BUCKET_LABEL[bucket]}).`,
      sample_bucket: bucket,
      sample_confidence_weight: sampleW,
      config_version: LABEL_CONFIG_VERSION,
    };
  }

  // 4) Profitable — selective-strategy friendly
  const meetsProfitable =
    trades >= thresholds.profitable_min_trades &&
    pf != null && pf >= thresholds.profitable_min_profit_factor &&
    (wr == null || wr >= thresholds.profitable_min_win_rate_pct) &&
    normNetMeetsProfitable &&
    (lDd == null || lDd <= thresholds.max_leverage_adjusted_drawdown_profitable) &&
    (np == null || np >= 0);

  if (meetsProfitable) {
    reason_codes.push('profitable_gates_met');
    return {
      label: 'profitable',
      reason: `PF ${pf!.toFixed(2)}${wr != null ? `, WR ${wr.toFixed(0)}%` : ''}${nNet != null ? `, norm net ${nNet.toFixed(1)}%` : ''} — meets Profitable gates (${trades} trades).`,
      confidence: sampleW < 0.5 ? 'low' : 'normal',
      quality_score: qScore,
      reason_codes,
      positive_drivers,
      negative_drivers,
      safety_overrides,
      summary: `Profitable gates met (${SAMPLE_BUCKET_LABEL[bucket]}).`,
      sample_bucket: bucket,
      sample_confidence_weight: sampleW,
      config_version: LABEL_CONFIG_VERSION,
    };
  }

  // 5) PF below marginal floor → rejected
  if (pf != null && pf < thresholds.marginal_min_profit_factor) {
    reason_codes.push('profit_factor_below_marginal_floor');
    return {
      label: 'rejected_backtest',
      reason: `Profit factor ${pf.toFixed(2)} < ${thresholds.marginal_min_profit_factor}.`,
      confidence: sampleW < 0.5 ? 'low' : 'normal',
      quality_score: qScore,
      reason_codes,
      positive_drivers,
      negative_drivers,
      safety_overrides,
      summary: `Profit factor below marginal floor.`,
      sample_bucket: bucket,
      sample_confidence_weight: sampleW,
      config_version: LABEL_CONFIG_VERSION,
    };
  }

  // 6) Marginal
  reason_codes.push('marginal_weak_positive');
  const bits: string[] = [];
  if (pf != null) bits.push(`PF ${pf.toFixed(2)}`);
  if (wr != null) bits.push(`WR ${wr.toFixed(0)}%`);
  if (nNet != null) bits.push(`norm net ${nNet.toFixed(1)}%`);
  if (lDd != null) bits.push(`lev-adj DD ${lDd.toFixed(1)}%`);
  return {
    label: 'marginal',
    reason: `Doesn't meet Profitable gates (${bits.join(', ') || 'weak metrics'}, ${trades} trades).`,
    confidence: sampleW < 0.5 ? 'low' : 'normal',
    quality_score: qScore,
    reason_codes,
    positive_drivers,
    negative_drivers,
    safety_overrides,
    summary: `Marginal — weak positive metrics (${SAMPLE_BUCKET_LABEL[bucket]}).`,
    sample_bucket: bucket,
    sample_confidence_weight: sampleW,
    config_version: LABEL_CONFIG_VERSION,
  };
}

/** Back-compat shim. */
export function autoSuggestLabelOnly(input: AutoSuggestInput): BacktestLabel {
  return autoSuggestLabel(input).label;
}

/**
 * Flags rows for review when the suggestion disagrees with the confirmed
 * label or when the confirmed label looks suspiciously strict given the
 * positive drivers.
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
  if ((confirmedLabel === 'marginal' || confirmedLabel === 'rejected_backtest') &&
      Object.keys(suggestion.positive_drivers).length >= 4 &&
      suggestion.safety_overrides.length === 0) {
    return {
      needs_review: true,
      reason: 'Confirmed label may be too strict — multiple positive drivers and no safety overrides.',
    };
  }
  return { needs_review: false, reason: null };
}
