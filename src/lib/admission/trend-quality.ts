// Trend Quality scoring for Coin Admission Screener.
// Pure functions — easy to unit-test. No I/O.

import { ema, adx, atr, type Bar } from '@/lib/analytics/indicators';

export interface TrendComponents {
  ema_alignment_5m: number;   // 0..100
  ema_alignment_15m: number;  // 0..100
  ema_alignment_1h: number;   // 0..100
  adx_5m: number;             // 0..100
  atr_normality: number;      // 0..100
  choppiness: number;         // 0..100 (higher = better, i.e. less choppy)
  pullback_quality: number;   // 0..100
}

export interface TrendQualityResult {
  score: number;
  components: TrendComponents;
}

/** EMA alignment: 100 if EMA20 > EMA50 > EMA200 (or all reversed), 50 if 2 of 3 ordered, 0 if mixed. */
function emaAlignment(bars: Bar[] | null | undefined): number {
  if (!bars || bars.length < 200) return 50; // not enough data → neutral
  const closes = bars.map((b) => b.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  if (e20 == null || e50 == null || e200 == null) return 50;
  const up = e20 > e50 && e50 > e200;
  const down = e20 < e50 && e50 < e200;
  if (up || down) return 100;
  const partial =
    (e20 > e50 && e20 > e200) ||
    (e20 < e50 && e20 < e200) ||
    (e50 > e200) ||
    (e50 < e200);
  return partial ? 60 : 20;
}

/** ADX(14): score peaks around 25-35. */
function adxScore(bars: Bar[] | null | undefined): number {
  if (!bars || bars.length < 30) return 50;
  const v = adx(bars, 14);
  if (v == null) return 50;
  if (v < 10) return 10;
  if (v < 20) return 40 + (v - 10) * 4; // 40..80
  if (v <= 40) return 80 + (40 - v) * 0.5; // ~80..70
  return Math.max(30, 70 - (v - 40)); // very high ADX = volatility risk
}

/** ATR% normality: prefer 0.3% – 2.5% per 5m bar. Too low = no movement, too high = chaos. */
function atrNormality(bars: Bar[] | null | undefined): number {
  if (!bars || bars.length < 20) return 50;
  const a = atr(bars, 14);
  const lastClose = bars[bars.length - 1]?.close;
  if (a == null || !lastClose || lastClose <= 0) return 50;
  const pct = (a / lastClose) * 100;
  if (pct < 0.1) return 20;
  if (pct < 0.3) return 60;
  if (pct <= 2.5) return 100 - Math.abs(pct - 1.0) * 15; // peak ~1%
  if (pct <= 5) return 60 - (pct - 2.5) * 12;
  return 10;
}

/** Choppiness Index (14): low = trending. Returns 0..100 where higher = better (less choppy). */
function choppinessScore(bars: Bar[] | null | undefined): number {
  if (!bars || bars.length < 20) return 50;
  const period = 14;
  const slice = bars.slice(-period - 1);
  let sumTr = 0;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = 1; i < slice.length; i++) {
    const b = slice[i];
    const p = slice[i - 1];
    sumTr += Math.max(
      b.high - b.low,
      Math.abs(b.high - p.close),
      Math.abs(b.low - p.close),
    );
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  const range = hi - lo;
  if (range <= 0 || sumTr <= 0) return 50;
  const ci = (100 * Math.log10(sumTr / range)) / Math.log10(period);
  // CI typically 0..100. <38 = trending, >62 = choppy.
  if (ci <= 38) return 100;
  if (ci >= 62) return 10;
  return 100 - ((ci - 38) / 24) * 90;
}

/** Pullback quality: share of recent closes between EMA20 and EMA50 (vs. far away). */
function pullbackQuality(bars: Bar[] | null | undefined): number {
  if (!bars || bars.length < 60) return 50;
  const closes = bars.map((b) => b.close);
  // Build trailing EMA20 / EMA50 series.
  const recent = closes.slice(-40);
  let inBand = 0;
  let counted = 0;
  for (let i = 0; i < recent.length; i++) {
    const sliceEnd = closes.length - (recent.length - 1 - i);
    const sub = closes.slice(0, sliceEnd);
    const e20 = ema(sub, 20);
    const e50 = ema(sub, 50);
    if (e20 == null || e50 == null) continue;
    const hi = Math.max(e20, e50);
    const lo = Math.min(e20, e50);
    const c = sub[sub.length - 1];
    // Within ±0.5% buffer around the band
    const buffer = lo * 0.005;
    if (c >= lo - buffer && c <= hi + buffer) inBand++;
    counted++;
  }
  if (counted === 0) return 50;
  const ratio = inBand / counted;
  // 20-50% within band = healthy pullbacks. Below = trend too aggressive; above = chop.
  if (ratio < 0.1) return 40;
  if (ratio <= 0.5) return 80 + (0.3 - Math.abs(ratio - 0.3)) * 100;
  if (ratio <= 0.7) return 60;
  return 30;
}

export function computeTrendQuality(
  bars5m: Bar[] | null,
  bars15m: Bar[] | null,
  bars1h: Bar[] | null,
): TrendQualityResult | null {
  // Need at least 5m data with EMA200 worth of bars.
  if (!bars5m || bars5m.length < 100) return null;

  const components: TrendComponents = {
    ema_alignment_5m: emaAlignment(bars5m),
    ema_alignment_15m: emaAlignment(bars15m),
    ema_alignment_1h: emaAlignment(bars1h),
    adx_5m: adxScore(bars5m),
    atr_normality: atrNormality(bars5m),
    choppiness: choppinessScore(bars5m),
    pullback_quality: pullbackQuality(bars5m),
  };

  const weights = {
    ema_alignment_5m: 0.25,
    ema_alignment_15m: 0.15,
    ema_alignment_1h: 0.15,
    adx_5m: 0.20,
    atr_normality: 0.10,
    choppiness: 0.10,
    pullback_quality: 0.05,
  };

  const score =
    components.ema_alignment_5m * weights.ema_alignment_5m +
    components.ema_alignment_15m * weights.ema_alignment_15m +
    components.ema_alignment_1h * weights.ema_alignment_1h +
    components.adx_5m * weights.adx_5m +
    components.atr_normality * weights.atr_normality +
    components.choppiness * weights.choppiness +
    components.pullback_quality * weights.pullback_quality;

  return {
    score: Math.round(score * 10) / 10,
    components,
  };
}
