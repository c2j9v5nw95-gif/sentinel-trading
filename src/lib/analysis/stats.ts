/**
 * Pure statistics helpers for the analysis page. No DB, no side effects.
 */

import type { AnalysisLabel, AnalysisRow, FeatureKey } from './analysis.functions';

export const LABEL_ORDER: AnalysisLabel[] = [
  'rejected_backtest',
  'marginal',
  'profitable',
  'profitable_plus',
];

export const LABEL_COLOR: Record<AnalysisLabel, string> = {
  no_trades: 'bg-slate-400/20 text-slate-700',
  rejected_backtest: 'bg-red-500/20 text-red-700',
  marginal: 'bg-yellow-500/20 text-yellow-800',
  profitable: 'bg-green-500/20 text-green-700',
  profitable_plus: 'bg-emerald-600/25 text-emerald-800',
};

export const LABEL_SCORE: Record<AnalysisLabel, number> = {
  no_trades: 0,
  rejected_backtest: 0,
  marginal: 1,
  profitable: 2,
  profitable_plus: 3,
};

export function nonNull(xs: Array<number | null | undefined>): number[] {
  return xs.filter((v): v is number => v != null && Number.isFinite(v));
}

export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next != null ? sorted[base] + rest * (next - sorted[base]) : sorted[base];
}

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const v of xs) s += v;
  return s / xs.length;
}

export function stdev(xs: number[], m?: number): number | null {
  if (xs.length < 2) return null;
  const mu = m ?? mean(xs)!;
  let s = 0;
  for (const v of xs) s += (v - mu) * (v - mu);
  return Math.sqrt(s / (xs.length - 1));
}

/** Cohen's d between two samples. Returns null if either lacks variance. */
export function cohensD(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const ma = mean(a)!;
  const mb = mean(b)!;
  const sa = stdev(a, ma)!;
  const sb = stdev(b, mb)!;
  const pooled = Math.sqrt(((a.length - 1) * sa * sa + (b.length - 1) * sb * sb) / (a.length + b.length - 2));
  if (!Number.isFinite(pooled) || pooled === 0) return null;
  return (ma - mb) / pooled;
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  if (!Number.isFinite(denom) || denom === 0) return null;
  return num / denom;
}

export interface FeatureSummary {
  feature: FeatureKey;
  perLabel: Record<AnalysisLabel, { n: number; median: number | null; p25: number | null; p75: number | null }>;
  separation: number | null; // Cohen's d, profitable+ vs rejected
  n: number;
  overallMedian: number | null;
}

export function summarizeFeature(rows: AnalysisRow[], feature: FeatureKey): FeatureSummary {
  const perLabel = {} as FeatureSummary['perLabel'];
  const bucket: Record<AnalysisLabel, number[]> = {
    no_trades: [], rejected_backtest: [], marginal: [], profitable: [], profitable_plus: [],
  };
  const all: number[] = [];
  for (const r of rows) {
    if (r.excluded || !r.label) continue;
    const v = r.features[feature];
    if (v == null) continue;
    bucket[r.label].push(v);
    all.push(v);
  }
  for (const lbl of LABEL_ORDER) {
    const vs = [...bucket[lbl]].sort((a, b) => a - b);
    perLabel[lbl] = {
      n: vs.length,
      median: quantile(vs, 0.5),
      p25: quantile(vs, 0.25),
      p75: quantile(vs, 0.75),
    };
  }
  perLabel.no_trades = { n: 0, median: null, p25: null, p75: null };
  const sortedAll = [...all].sort((a, b) => a - b);
  return {
    feature,
    perLabel,
    separation: cohensD(bucket.profitable_plus.concat(bucket.profitable), bucket.rejected_backtest),
    n: all.length,
    overallMedian: quantile(sortedAll, 0.5),
  };
}

export function correlateFeatureWithTargets(
  rows: AnalysisRow[],
  feature: FeatureKey,
): { net: number | null; pf: number | null; win: number | null; n: number } {
  const f: number[] = [], net: number[] = [], pf: number[] = [], win: number[] = [];
  for (const r of rows) {
    if (r.excluded) continue;
    const fv = r.features[feature];
    if (fv == null) continue;
    if (r.net_profit_pct != null) { f.push(fv); net.push(r.net_profit_pct); }
  }
  const f2: number[] = [], pf2: number[] = [];
  for (const r of rows) {
    if (r.excluded) continue;
    const fv = r.features[feature];
    if (fv == null || r.profit_factor == null) continue;
    f2.push(fv); pf2.push(r.profit_factor);
  }
  const f3: number[] = [], win2: number[] = [];
  for (const r of rows) {
    if (r.excluded) continue;
    const fv = r.features[feature];
    if (fv == null || r.win_rate_pct == null) continue;
    f3.push(fv); win2.push(r.win_rate_pct);
  }
  return {
    net: pearson(f, net),
    pf: pearson(f2, pf2),
    win: pearson(f3, win2),
    n: f.length,
  };
}

/** Quartile bucket assignment (Q1..Q4) based on non-null feature distribution. */
export function bucketByQuartile(
  rows: AnalysisRow[],
  feature: FeatureKey,
): { edges: [number, number, number, number, number]; buckets: AnalysisRow[][] } | null {
  const vals: number[] = [];
  for (const r of rows) {
    if (r.excluded) continue;
    const v = r.features[feature];
    if (v != null) vals.push(v);
  }
  if (vals.length < 4) return null;
  vals.sort((a, b) => a - b);
  const q1 = quantile(vals, 0.25)!;
  const q2 = quantile(vals, 0.5)!;
  const q3 = quantile(vals, 0.75)!;
  const min = vals[0];
  const max = vals[vals.length - 1];
  const buckets: AnalysisRow[][] = [[], [], [], []];
  for (const r of rows) {
    if (r.excluded) continue;
    const v = r.features[feature];
    if (v == null) continue;
    const idx = v <= q1 ? 0 : v <= q2 ? 1 : v <= q3 ? 2 : 3;
    buckets[idx].push(r);
  }
  return { edges: [min, q1, q2, q3, max], buckets };
}

export function labelMix(rows: AnalysisRow[]): {
  n: number;
  counts: Record<AnalysisLabel, number>;
  winShare: number; // profitable + profitable_plus / n
} {
  const counts: Record<AnalysisLabel, number> = {
    no_trades: 0, rejected_backtest: 0, marginal: 0, profitable: 0, profitable_plus: 0,
  };
  let n = 0;
  for (const r of rows) {
    if (!r.label) continue;
    counts[r.label]++;
    n++;
  }
  const winShare = n === 0 ? 0 : (counts.profitable + counts.profitable_plus) / n;
  return { n, counts, winShare };
}

/**
 * Composite ranking score. Each component normalized to [0,1] via robust
 * min–max (5th–95th percentile clamp). Returns null score for excluded rows.
 */
export interface ScoreWeights {
  quality: number;
  pf: number;
  riskAdj: number; // net% / |dd%|
  label: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = { quality: 0.30, pf: 0.25, riskAdj: 0.25, label: 0.20 };

export interface RankedRow {
  row: AnalysisRow;
  score: number;
  parts: { quality: number; pf: number; riskAdj: number; label: number };
}

function robustNorm(vals: Array<number | null>): (v: number | null) => number {
  const xs = nonNull(vals).slice().sort((a, b) => a - b);
  if (xs.length < 2) return () => 0;
  const lo = quantile(xs, 0.05) ?? xs[0];
  const hi = quantile(xs, 0.95) ?? xs[xs.length - 1];
  const span = hi - lo;
  if (!Number.isFinite(span) || span === 0) return () => 0;
  return (v) => {
    if (v == null) return 0;
    const t = (v - lo) / span;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };
}

export function rankRows(rows: AnalysisRow[], weights: ScoreWeights): RankedRow[] {
  const active = rows.filter((r) => !r.excluded);
  const normQ = robustNorm(active.map((r) => r.backtest_quality_score));
  const normPF = robustNorm(active.map((r) => r.profit_factor));
  const normRA = robustNorm(active.map((r) => {
    if (r.net_profit_pct == null || r.max_drawdown_pct == null) return null;
    const dd = Math.abs(r.max_drawdown_pct);
    return dd < 0.01 ? null : r.net_profit_pct / dd;
  }));
  const wSum = weights.quality + weights.pf + weights.riskAdj + weights.label || 1;

  return active
    .map((r) => {
      const q = normQ(r.backtest_quality_score);
      const pf = normPF(r.profit_factor);
      const ra = normRA(
        r.net_profit_pct != null && r.max_drawdown_pct != null && Math.abs(r.max_drawdown_pct) >= 0.01
          ? r.net_profit_pct / Math.abs(r.max_drawdown_pct)
          : null,
      );
      const labelBonus = r.label ? LABEL_SCORE[r.label] / 3 : 0;
      const score = (weights.quality * q + weights.pf * pf + weights.riskAdj * ra + weights.label * labelBonus) / wSum;
      return {
        row: r,
        score,
        parts: { quality: q, pf, riskAdj: ra, label: labelBonus },
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** k-nearest peers by z-scored feature vector distance. */
export function findPeers(
  rows: AnalysisRow[],
  target: AnalysisRow,
  features: FeatureKey[],
  k: number,
): AnalysisRow[] {
  const stats = features.map((f) => {
    const vs = nonNull(rows.map((r) => r.features[f]));
    return { f, mu: mean(vs) ?? 0, sd: stdev(vs) ?? 1 };
  });
  const vec = (r: AnalysisRow) =>
    stats.map(({ f, mu, sd }) => {
      const v = r.features[f];
      if (v == null || sd === 0) return null;
      return (v - mu) / sd;
    });
  const tv = vec(target);
  const dists = rows
    .filter((r) => r.id !== target.id && !r.excluded)
    .map((r) => {
      const rv = vec(r);
      let s = 0, n = 0;
      for (let i = 0; i < tv.length; i++) {
        const a = tv[i], b = rv[i];
        if (a == null || b == null) continue;
        s += (a - b) * (a - b); n++;
      }
      if (n < features.length / 2) return null;
      return { r, d: Math.sqrt(s / n) };
    })
    .filter((x): x is { r: AnalysisRow; d: number } => x != null)
    .sort((a, b) => a.d - b.d)
    .slice(0, k);
  return dists.map((x) => x.r);
}
