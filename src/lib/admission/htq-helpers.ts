// Helpers for Historical Trend Quality v2.
// Pure functions — no I/O. Easy to unit-test.

import type { Bar } from '@/lib/analytics/indicators';
import { atr } from '@/lib/analytics/indicators';

export type Regime = 'bull' | 'bear' | 'neutral';

/** Build per-bar regime series using EMA20 / EMA50 / close direction.
 *  bullish: EMA20 > EMA50 AND close > EMA20
 *  bearish: EMA20 < EMA50 AND close < EMA20
 *  else neutral
 */
export function regimeSeries(bars: Bar[]): Regime[] {
  const n = bars.length;
  const out: Regime[] = new Array(n).fill('neutral');
  if (n < 50) return out;
  const k20 = 2 / 21;
  const k50 = 2 / 51;
  let e20 = bars.slice(0, 20).reduce((a, b) => a + b.close, 0) / 20;
  let e50 = bars.slice(0, 50).reduce((a, b) => a + b.close, 0) / 50;
  for (let i = 0; i < n; i++) {
    const c = bars[i].close;
    if (i >= 20) e20 = c * k20 + e20 * (1 - k20);
    if (i >= 50) e50 = c * k50 + e50 * (1 - k50);
    if (i < 50) { out[i] = 'neutral'; continue; }
    if (e20 > e50 && c > e20) out[i] = 'bull';
    else if (e20 < e50 && c < e20) out[i] = 'bear';
    else out[i] = 'neutral';
  }
  return out;
}

export interface RegimeRun {
  regime: Regime;
  startIdx: number;
  endIdx: number; // inclusive
  length: number;
}

/** Collapse a regime series into runs. */
export function regimeRuns(regimes: Regime[]): RegimeRun[] {
  const runs: RegimeRun[] = [];
  if (regimes.length === 0) return runs;
  let cur = regimes[0];
  let start = 0;
  for (let i = 1; i < regimes.length; i++) {
    if (regimes[i] !== cur) {
      runs.push({ regime: cur, startIdx: start, endIdx: i - 1, length: i - start });
      cur = regimes[i];
      start = i;
    }
  }
  runs.push({ regime: cur, startIdx: start, endIdx: regimes.length - 1, length: regimes.length - start });
  return runs;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Trend Persistence component (0..100) on 1h regime data.
 *  Blends median run duration (hours) with overall trend-time percentage.
 */
export function persistenceScore(runs: RegimeRun[], totalBars: number): {
  score: number;
  median_hours: number;
  trend_time_pct: number;
  trend_runs: number;
} {
  const nonNeutral = runs.filter((r) => r.regime !== 'neutral');
  if (totalBars === 0) return { score: 0, median_hours: 0, trend_time_pct: 0, trend_runs: 0 };
  const lengths = nonNeutral.map((r) => r.length);
  const med = median(lengths) ?? 0;
  const trendBars = nonNeutral.reduce((a, r) => a + r.length, 0);
  const trendTimePct = (trendBars / totalBars) * 100;

  // Map median hours: 0→0, 4→40, 12→80, 24→100, cap.
  const fMed = med >= 24 ? 100
    : med >= 12 ? 80 + ((med - 12) / 12) * 20
    : med >= 4 ? 40 + ((med - 4) / 8) * 40
    : (med / 4) * 40;

  // Map trend_time_pct: 30→30, 60→80, 80→100
  const fTime = trendTimePct >= 80 ? 100
    : trendTimePct >= 60 ? 80 + ((trendTimePct - 60) / 20) * 20
    : trendTimePct >= 30 ? 30 + ((trendTimePct - 30) / 30) * 50
    : (trendTimePct / 30) * 30;

  return {
    score: Math.max(0, Math.min(100, fMed * 0.5 + fTime * 0.5)),
    median_hours: Math.round(med * 10) / 10,
    trend_time_pct: Math.round(trendTimePct * 10) / 10,
    trend_runs: nonNeutral.length,
  };
}

/** Multi-timeframe alignment: % of 1h bars whose corresponding 5m + 15m + 1h all agree on bull/bear. */
export function mtfAlignment(
  bars1h: Bar[],
  bars15m: Bar[],
  bars5m: Bar[],
): { score: number; pct: number } {
  if (bars1h.length < 50 || bars15m.length < 50 || bars5m.length < 50) {
    return { score: 50, pct: 0 };
  }
  const r1 = regimeSeries(bars1h);
  const r15 = regimeSeries(bars15m);
  const r5 = regimeSeries(bars5m);

  // For each 1h bar, find the 15m and 5m bar whose time is closest <= 1h bar time
  let aligned = 0;
  let evaluated = 0;
  let j15 = 0;
  let j5 = 0;
  for (let i = 50; i < bars1h.length; i++) {
    const t = bars1h[i].bar_time;
    while (j15 + 1 < bars15m.length && bars15m[j15 + 1].bar_time <= t) j15++;
    while (j5 + 1 < bars5m.length && bars5m[j5 + 1].bar_time <= t) j5++;
    if (bars15m[j15].bar_time > t || bars5m[j5].bar_time > t) continue;
    evaluated++;
    const a = r1[i], b = r15[j15], c = r5[j5];
    if (a !== 'neutral' && a === b && b === c) aligned++;
  }
  if (evaluated === 0) return { score: 50, pct: 0 };
  const pct = (aligned / evaluated) * 100;
  // Map: 70% → 100, 30% → 30, 0% → 0
  const score = pct >= 70 ? 100 : pct >= 30 ? 30 + ((pct - 30) / 40) * 70 : (pct / 30) * 30;
  return { score: Math.max(0, Math.min(100, score)), pct: Math.round(pct * 10) / 10 };
}

/** Trend Tradeability on 5m: share of 5m bars during trend periods that stayed within ±1 ATR of EMA20. */
export function tradeability5m(
  bars5m: Bar[],
  trendMask: boolean[],
): { score: number; in_band_pct: number } {
  if (bars5m.length < 50) return { score: 50, in_band_pct: 0 };
  const closes = bars5m.map((b) => b.close);
  // EMA20 series
  const ema20: number[] = new Array(closes.length).fill(NaN);
  const k = 2 / 21;
  let e = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  ema20[19] = e;
  for (let i = 20; i < closes.length; i++) { e = closes[i] * k + e * (1 - k); ema20[i] = e; }
  // Rolling ATR(14) using running approximation
  const a14 = atr(bars5m, 14);
  if (a14 == null || a14 <= 0) return { score: 50, in_band_pct: 0 };

  let inBand = 0;
  let counted = 0;
  for (let i = 19; i < bars5m.length; i++) {
    if (!trendMask[i]) continue;
    counted++;
    const dist = Math.abs(bars5m[i].close - ema20[i]);
    if (dist <= a14) inBand++;
  }
  if (counted === 0) return { score: 50, in_band_pct: 0 };
  const pct = (inBand / counted) * 100;
  // 60..85% is ideal: enough pullbacks (some outside) and bars hugging EMA20.
  const score = pct >= 60 && pct <= 85 ? 100
    : pct >= 40 && pct < 60 ? 60 + ((pct - 40) / 20) * 40
    : pct > 85 && pct <= 95 ? 100 - ((pct - 85) / 10) * 30
    : pct > 95 ? 40
    : (pct / 40) * 60;
  return { score: Math.max(0, Math.min(100, score)), in_band_pct: Math.round(pct * 10) / 10 };
}

/** Chop / Flip frequency on 1h: regime flips per day. */
export function flipFrequency(runs: RegimeRun[], totalHours: number): {
  score: number;
  flips_per_day: number;
} {
  if (totalHours <= 0) return { score: 50, flips_per_day: 0 };
  // A flip = transition between bull <-> bear (ignore neutral transitions for stricter count).
  // But include neutral->bull/bear too as "regime change".
  const flips = Math.max(0, runs.length - 1);
  const days = totalHours / 24;
  const fpd = days > 0 ? flips / days : 0;
  // 0/d → 100, 1/d → 80, 2/d → 60, 3/d → 30, ≥5/d → 0
  const score = fpd <= 0.5 ? 100
    : fpd <= 1 ? 100 - (fpd - 0.5) * 40
    : fpd <= 2 ? 80 - (fpd - 1) * 20
    : fpd <= 3 ? 60 - (fpd - 2) * 30
    : fpd <= 5 ? 30 - (fpd - 3) * 15
    : 0;
  return { score: Math.max(0, Math.min(100, score)), flips_per_day: Math.round(fpd * 100) / 100 };
}

/** Smoothness / efficiency per 1h trend-run: |close_end - close_start| / Σ|return_i|.
 *  Returns median across non-neutral runs (length >= 3).
 */
export function smoothnessScore(bars1h: Bar[], runs: RegimeRun[]): {
  score: number;
  median_efficiency: number;
} {
  const effs: number[] = [];
  for (const run of runs) {
    if (run.regime === 'neutral') continue;
    if (run.length < 3) continue;
    const startC = bars1h[run.startIdx].close;
    const endC = bars1h[run.endIdx].close;
    let sumAbs = 0;
    for (let i = run.startIdx + 1; i <= run.endIdx; i++) {
      sumAbs += Math.abs(bars1h[i].close - bars1h[i - 1].close);
    }
    if (sumAbs <= 0) continue;
    effs.push(Math.abs(endC - startC) / sumAbs);
  }
  const med = median(effs);
  if (med == null) return { score: 50, median_efficiency: 0 };
  // 0.05 → 0, 0.15 → 50, 0.3 → 100
  const score = med >= 0.3 ? 100 : med >= 0.05 ? ((med - 0.05) / 0.25) * 100 : 0;
  return {
    score: Math.max(0, Math.min(100, score)),
    median_efficiency: Math.round(med * 1000) / 1000,
  };
}

/** Wick/spike penalty during trend periods on 5m: % of 5m trend bars with wick (high-low) > 2x ATR. */
export function wickPenaltyDuringTrends(
  bars5m: Bar[],
  trendMask5m: boolean[],
): { score: number; wick_pct: number } {
  if (bars5m.length < 30) return { score: 50, wick_pct: 0 };
  const a = atr(bars5m, 14);
  if (a == null || a <= 0) return { score: 50, wick_pct: 0 };
  let bad = 0;
  let counted = 0;
  for (let i = 14; i < bars5m.length; i++) {
    if (!trendMask5m[i]) continue;
    counted++;
    const range = bars5m[i].high - bars5m[i].low;
    if (range > 2 * a) bad++;
  }
  if (counted === 0) return { score: 100, wick_pct: 0 };
  const pct = (bad / counted) * 100;
  // 0% → 100, 5% → 0
  const score = pct >= 5 ? 0 : 100 - (pct / 5) * 100;
  return { score: Math.max(0, Math.min(100, score)), wick_pct: Math.round(pct * 100) / 100 };
}

/** Build a 5m trend mask aligned to 1h regimes (true if corresponding 1h bar is bull or bear). */
export function buildTrendMask5m(bars5m: Bar[], bars1h: Bar[], regimes1h: Regime[]): boolean[] {
  const mask = new Array(bars5m.length).fill(false);
  if (bars1h.length === 0) return mask;
  let j = 0;
  for (let i = 0; i < bars5m.length; i++) {
    const t = bars5m[i].bar_time;
    while (j + 1 < bars1h.length && bars1h[j + 1].bar_time <= t) j++;
    if (bars1h[j].bar_time > t) continue;
    mask[i] = regimes1h[j] !== 'neutral';
  }
  return mask;
}
