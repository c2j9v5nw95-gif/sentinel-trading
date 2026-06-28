// Pure scoring helper for "Coin Candidate Score" (master score) on the
// Admission page. No I/O, no DB, no side effects. Easy to test.
//
// Strict invariants:
//   * Never reduces a score because a component is missing — redistributes
//     weight to the components that DO have data.
//   * `no_trades` and missing backtest are treated as ABSENT, not zero.
//   * Hard kill rules CAP the final displayed score and flip
//     `tradeEligible=false`, but the raw (pre-cap) score is preserved.
//   * Never changes admission status, kNN weights, labels, or execution.
//   * Final score is always normalized to 0..100 via
//     sum(value * eff_weight) / sum(active_eff_weights).

export type BtTrust = 'trusted' | 'needs_review' | 'no_trades' | 'missing';
export type CalibConfidence = 'low' | 'medium' | 'high' | null | undefined;

export interface CandidateScoreInput {
  /** Robustness / market quality, 0..100. */
  robustness: number | null;
  /** Historical Trend Quality, 0..100. */
  htq: number | null;
  /** kNN calibration score, 0..100. */
  calibration: number | null;
  calibrationConfidence: CalibConfidence;
  /** Backtest Quality Score, 0..100. Pass null when no BT / no_trades. */
  btScore: number | null;
  btTrust: BtTrust;
  /** Current Momentum, 0..100. Optional — low weight by design. */
  momentum: number | null;
  /** Hard kill rule strings; non-empty → cap. */
  hardKills: string[];
  /** Optional fallback to display when all main components are missing. */
  fallbackStrategyFit?: number | null;
}

export type ComponentKey =
  | 'market'
  | 'htq'
  | 'calibration'
  | 'backtest'
  | 'momentum';

export interface CandidateComponent {
  key: ComponentKey;
  label: string;
  value: number | null;
  originalWeight: number;     // 0..100
  effectiveWeight: number;    // 0..100, after redistribution
  contribution: number;       // value * effectiveWeight (0 when value null)
  note?: string;
}

export type CandidateBucket =
  | 'prime'
  | 'strong'
  | 'watch'
  | 'weak'
  | 'avoid'
  | 'blocked';

export interface CandidateScoreResult {
  /** Final, displayed 0..100 (after hard-kill cap). Null when no signal at all. */
  score: number | null;
  /** Pre-cap normalized score 0..100. Null when no active components. */
  rawScore: number | null;
  bucket: CandidateBucket;
  tradeEligible: boolean;
  hardKillCapped: boolean;
  components: CandidateComponent[];
  notes: string[];
  /** True when score had to fall back to fallbackStrategyFit. */
  usedFallback: boolean;
}

const ORIGINAL_WEIGHTS: Record<ComponentKey, number> = {
  market: 25,
  htq: 25,
  calibration: 20,
  backtest: 20,
  momentum: 10,
};

const LABELS: Record<ComponentKey, string> = {
  market: 'Market Quality / Robustness',
  htq: 'Historical Trend Quality',
  calibration: 'Calibration Score',
  backtest: 'Backtest Quality',
  momentum: 'Current Momentum',
};

function redistribute(
  pool: number,
  targets: ComponentKey[],
  eff: Record<ComponentKey, number>,
  values: Record<ComponentKey, number | null>,
) {
  // Only push weight onto targets that actually have data.
  const eligible = targets.filter((k) => values[k] != null);
  if (eligible.length === 0 || pool <= 0) return;
  const base = eligible.reduce((s, k) => s + ORIGINAL_WEIGHTS[k], 0);
  if (base <= 0) return;
  for (const k of eligible) {
    eff[k] += (ORIGINAL_WEIGHTS[k] / base) * pool;
  }
}

function bucketFor(score: number): CandidateBucket {
  if (score >= 80) return 'prime';
  if (score >= 65) return 'strong';
  if (score >= 50) return 'watch';
  if (score >= 35) return 'weak';
  return 'avoid';
}

export function computeCandidateScore(
  input: CandidateScoreInput,
): CandidateScoreResult {
  const values: Record<ComponentKey, number | null> = {
    market: input.robustness,
    htq: input.htq,
    calibration: input.calibration,
    backtest: input.btScore,
    momentum: input.momentum,
  };

  const eff: Record<ComponentKey, number> = { ...ORIGINAL_WEIGHTS };
  const notes: string[] = [];

  // ---- Backtest handling first (its missing weight may flow to calib) ----
  if (input.btTrust === 'no_trades') {
    values.backtest = null;
    eff.backtest = 0;
    redistribute(ORIGINAL_WEIGHTS.backtest, ['market', 'htq', 'calibration'], eff, values);
    notes.push('No trades observed in backtest period — BT excluded, weight redistributed.');
  } else if (input.btTrust === 'missing' || values.backtest == null) {
    values.backtest = null;
    eff.backtest = 0;
    redistribute(ORIGINAL_WEIGHTS.backtest, ['market', 'htq', 'calibration'], eff, values);
    notes.push('No backtest available — BT weight redistributed to Market / HTQ / Calibration.');
  } else if (input.btTrust === 'needs_review') {
    // Halve BT weight, redistribute the other half.
    const halved = ORIGINAL_WEIGHTS.backtest / 2;
    eff.backtest = halved;
    redistribute(halved, ['market', 'htq', 'calibration'], eff, values);
    notes.push('Backtest label needs review — BT contribution reduced 50%.');
  }

  // ---- Calibration handling ----
  if (values.calibration == null) {
    eff.calibration = 0;
    redistribute(ORIGINAL_WEIGHTS.calibration, ['market', 'htq'], eff, values);
    notes.push('Calibration unavailable — weight redistributed to Market / HTQ.');
  } else if (input.calibrationConfidence === 'low') {
    // Halve calibration contribution; redistribute the other half.
    const before = eff.calibration;
    const halved = before / 2;
    eff.calibration = halved;
    redistribute(before - halved, ['market', 'htq'], eff, values);
    notes.push('Calibration low confidence — contribution reduced.');
  }

  // ---- Momentum handling ----
  if (values.momentum == null) {
    eff.momentum = 0;
    redistribute(ORIGINAL_WEIGHTS.momentum, ['market', 'htq'], eff, values);
  }

  // ---- Normalize ----
  let activeWeight = 0;
  let weighted = 0;
  const components: CandidateComponent[] = (Object.keys(ORIGINAL_WEIGHTS) as ComponentKey[]).map((k) => {
    const v = values[k];
    const w = eff[k];
    const contrib = v != null ? v * w : 0;
    if (v != null && w > 0) {
      activeWeight += w;
      weighted += contrib;
    }
    let note: string | undefined;
    if (k === 'backtest') {
      if (input.btTrust === 'no_trades') note = 'No Setup (N/A)';
      else if (input.btTrust === 'missing') note = 'N/A — no backtest';
      else if (input.btTrust === 'needs_review') note = 'needs review — 50% weight';
    } else if (k === 'calibration') {
      if (v == null) note = 'N/A — weight redistributed';
      else if (input.calibrationConfidence === 'low') note = 'low confidence — 50% weight';
    } else if (k === 'momentum' && v == null) {
      note = 'N/A — weight redistributed';
    }
    return {
      key: k,
      label: LABELS[k],
      value: v,
      originalWeight: ORIGINAL_WEIGHTS[k],
      effectiveWeight: w,
      contribution: contrib,
      note,
    };
  });

  let usedFallback = false;
  let rawScore: number | null = activeWeight > 0 ? weighted / activeWeight : null;

  if (rawScore == null && input.fallbackStrategyFit != null && Number.isFinite(input.fallbackStrategyFit)) {
    rawScore = input.fallbackStrategyFit;
    usedFallback = true;
    notes.push('All main components missing — falling back to Strategy Fit.');
  }

  if (rawScore == null) {
    return {
      score: null,
      rawScore: null,
      bucket: 'avoid',
      tradeEligible: input.hardKills.length === 0,
      hardKillCapped: false,
      components,
      notes: ['No signal — score unavailable.'],
      usedFallback: false,
    };
  }

  // Clamp pre-cap to 0..100 for safety.
  rawScore = Math.max(0, Math.min(100, rawScore));

  const hardKillCapped = input.hardKills.length > 0;
  let finalScore = rawScore;
  let bucket: CandidateBucket;
  if (hardKillCapped) {
    finalScore = Math.min(rawScore, 49);
    bucket = 'blocked';
    notes.push(`Hard kill active: ${input.hardKills.join(', ')} — score capped at 49.`);
  } else {
    bucket = bucketFor(finalScore);
  }

  return {
    score: Math.round(finalScore * 10) / 10,
    rawScore: Math.round(rawScore * 10) / 10,
    bucket,
    tradeEligible: !hardKillCapped,
    hardKillCapped,
    components,
    notes,
    usedFallback,
  };
}

export function candidateBucketBadgeClass(b: CandidateBucket): string {
  switch (b) {
    case 'prime': return 'bg-emerald-500/25 text-emerald-700';
    case 'strong': return 'bg-green-500/20 text-green-700';
    case 'watch': return 'bg-yellow-500/20 text-yellow-700';
    case 'weak': return 'bg-orange-500/20 text-orange-700';
    case 'avoid': return 'bg-red-500/20 text-red-700';
    case 'blocked': return 'bg-slate-500/25 text-slate-700 line-through';
  }
}

export function candidateBucketBarClass(b: CandidateBucket): string {
  switch (b) {
    case 'prime': return 'bg-emerald-500';
    case 'strong': return 'bg-green-500';
    case 'watch': return 'bg-yellow-500';
    case 'weak': return 'bg-orange-500';
    case 'avoid': return 'bg-red-500';
    case 'blocked': return 'bg-slate-500';
  }
}

export function candidateBucketLabel(b: CandidateBucket): string {
  switch (b) {
    case 'prime': return 'Prime';
    case 'strong': return 'Strong';
    case 'watch': return 'Watch';
    case 'weak': return 'Weak';
    case 'avoid': return 'Avoid';
    case 'blocked': return 'Blocked';
  }
}
