// Historical Trend Quality v2 — measures whether a coin HISTORICALLY had
// long, calm, tradeable trend periods. Distinct from "Current Momentum".
//
// Inputs: 1h klines (primary), 15m (secondary), 5m (noise + execution feel).
// Pure function. No I/O.

import type { Bar } from '@/lib/analytics/indicators';
import {
  regimeSeries,
  regimeRuns,
  persistenceScore,
  mtfAlignment,
  tradeability5m,
  flipFrequency,
  smoothnessScore,
  wickPenaltyDuringTrends,
  buildTrendMask5m,
} from './htq-helpers';

export type TrendClassification = 'trend_friendly' | 'neutral' | 'choppy';

export interface HtqComponents {
  persistence_1h: number;
  mtf_alignment: number;
  tradeability_5m: number;
  flip_frequency: number;
  smoothness: number;
  wick_penalty: number;
  // raw metrics for display
  median_trend_duration_hours: number;
  trend_time_pct: number;
  mtf_alignment_pct: number;
  flips_per_day: number;
  median_efficiency: number;
  wick_pct_during_trends: number;
  trend_runs_1h: number;
}

export interface HtqResult {
  score: number;
  classification: TrendClassification;
  reason: string;
  components: HtqComponents;
  lookback_days: number;
  mode: 'standard' | 'emerging';
}

const WEIGHTS = {
  persistence_1h: 0.30,
  mtf_alignment: 0.20,
  tradeability_5m: 0.20,
  flip_frequency: 0.15,
  smoothness: 0.10,
  wick_penalty: 0.05,
};

export function computeHistoricalTrendQuality(
  bars1h: Bar[] | null | undefined,
  bars15m: Bar[] | null | undefined,
  bars5m: Bar[] | null | undefined,
  lookback_days: number,
): HtqResult | null {
  if (!bars1h || bars1h.length < 50) return null;

  const totalBars1h = bars1h.length;
  const totalHours = totalBars1h; // 1 bar = 1 hour
  const regimes1h = regimeSeries(bars1h);
  const runs1h = regimeRuns(regimes1h);

  const pers = persistenceScore(runs1h, totalBars1h);
  const mtf = (bars15m && bars5m && bars15m.length >= 50 && bars5m.length >= 50)
    ? mtfAlignment(bars1h, bars15m, bars5m)
    : { score: 50, pct: 0 };

  const trendMask5m = bars5m ? buildTrendMask5m(bars5m, bars1h, regimes1h) : [];
  const trade = bars5m && bars5m.length >= 50
    ? tradeability5m(bars5m, trendMask5m)
    : { score: 50, in_band_pct: 0 };

  const flip = flipFrequency(runs1h, totalHours);
  const smooth = smoothnessScore(bars1h, runs1h);
  const wick = bars5m && bars5m.length >= 30
    ? wickPenaltyDuringTrends(bars5m, trendMask5m)
    : { score: 50, wick_pct: 0 };

  const components: HtqComponents = {
    persistence_1h: round1(pers.score),
    mtf_alignment: round1(mtf.score),
    tradeability_5m: round1(trade.score),
    flip_frequency: round1(flip.score),
    smoothness: round1(smooth.score),
    wick_penalty: round1(wick.score),
    median_trend_duration_hours: pers.median_hours,
    trend_time_pct: pers.trend_time_pct,
    mtf_alignment_pct: mtf.pct,
    flips_per_day: flip.flips_per_day,
    median_efficiency: smooth.median_efficiency,
    wick_pct_during_trends: wick.wick_pct,
    trend_runs_1h: pers.trend_runs,
  };

  const score =
    components.persistence_1h * WEIGHTS.persistence_1h +
    components.mtf_alignment * WEIGHTS.mtf_alignment +
    components.tradeability_5m * WEIGHTS.tradeability_5m +
    components.flip_frequency * WEIGHTS.flip_frequency +
    components.smoothness * WEIGHTS.smoothness +
    components.wick_penalty * WEIGHTS.wick_penalty;

  const finalScore = round1(score);
  const classification: TrendClassification = finalScore >= 75
    ? 'trend_friendly'
    : finalScore >= 55 ? 'neutral' : 'choppy';

  const reason = buildReason(finalScore, classification, components);
  const mode: 'standard' | 'emerging' = lookback_days < 14 ? 'emerging' : 'standard';

  return {
    score: finalScore,
    classification,
    reason,
    components,
    lookback_days,
    mode,
  };
}

function buildReason(score: number, cls: TrendClassification, c: HtqComponents): string {
  const parts: string[] = [];
  if (cls === 'trend_friendly') parts.push('Historically tidy trend periods');
  else if (cls === 'neutral') parts.push('Mixed trend behaviour');
  else parts.push('Choppy / not trend-friendly');
  parts.push(`med dur ${c.median_trend_duration_hours}h`);
  parts.push(`${c.trend_time_pct.toFixed(0)}% trend-time`);
  parts.push(`${c.flips_per_day.toFixed(2)} flips/day`);
  parts.push(`eff ${c.median_efficiency.toFixed(2)}`);
  return parts.join(' · ');
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
