/**
 * Inline calibration runner — used by admission run handler so we can reuse the
 * caller's authenticated supabase client (no server-fn-from-server-fn RPC).
 *
 * Keeps the heavy logic out of the route module while sharing the scoring code.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  calibrateCandidate,
  computeFeatureMedians,
  computeFeatureStds,
  extractFeatures,
  type BacktestLabel,
  type CalibrationResult,
  type Observation,
  type ScreenerSnapshot,
} from './scoring';

function ageDays(testDate: string): number {
  const t = new Date(testDate + 'T00:00:00Z').getTime();
  return Math.max(0, (Date.now() - t) / 86_400_000);
}

export async function runCalibrationForRunInline(
  supabase: SupabaseClient,
  runId: string,
  strategyVersion: string | null,
): Promise<{ rows_ok: number; rows_unavailable: number; observations_used: number }> {
  const { data: cfgRow } = await supabase
    .from('app_settings')
    .select(
      'calibration_half_life_days, calibration_k, calibration_min_neighbors_medium, calibration_min_neighbors_high',
    )
    .eq('singleton', true)
    .maybeSingle();
  const cfg = {
    k: cfgRow?.calibration_k ?? 5,
    half_life_days: cfgRow?.calibration_half_life_days ?? 180,
    min_neighbors_medium: cfgRow?.calibration_min_neighbors_medium ?? 3,
    min_neighbors_high: cfgRow?.calibration_min_neighbors_high ?? 6,
  };

  let q = supabase
    .from('coin_backtest_results')
    .select('id, symbol, test_date, label, screener_snapshot, strategy_version')
    .in('extraction_status', ['manual', 'confirmed'])
    .order('test_date', { ascending: false })
    .limit(2000);
  if (strategyVersion) q = q.eq('strategy_version', strategyVersion);
  const { data: obsRows } = await q;
  const observations: Observation[] = (obsRows ?? []).map((r: any) => ({
    id: r.id,
    symbol: r.symbol,
    test_date: r.test_date,
    label: r.label as BacktestLabel,
    age_days: ageDays(r.test_date),
    features: extractFeatures((r.screener_snapshot ?? {}) as ScreenerSnapshot),
  }));
  const featureRows = observations.map((o) => o.features);
  const medians = computeFeatureMedians(featureRows);
  const stds = computeFeatureStds(featureRows, medians);

  const { data: rows } = await supabase
    .from('coin_admission_results')
    .select(
      'id, score, historical_trend_quality, htq_components, current_momentum_score, turnover_24h, turnover_7d_median, open_interest_value, spread_bps, listing_age_days, strategy_fit_score',
    )
    .eq('run_id', runId);

  const computedAt = new Date().toISOString();
  let okCount = 0;
  let unavailableCount = 0;

  for (const r of rows ?? []) {
    let res: CalibrationResult | null = null;
    let status: 'ok' | 'unavailable' = 'ok';
    let reason: string | null = null;
    try {
      if (observations.length === 0) {
        status = 'unavailable';
        reason = 'no_observations';
      } else {
        const candFeatures = extractFeatures({
          robustness: r.score,
          historical_trend_quality: r.historical_trend_quality,
          htq_components: r.htq_components as any,
          current_momentum_score: r.current_momentum_score,
          turnover_24h: r.turnover_24h,
          turnover_7d_median: r.turnover_7d_median,
          open_interest_value: r.open_interest_value,
          spread_bps: r.spread_bps,
          listing_age_days: r.listing_age_days,
        });
        res = calibrateCandidate(candFeatures, observations, medians, stds, cfg);
        if (!res) {
          status = 'unavailable';
          reason = 'calibration_empty';
        }
      }
    } catch (err) {
      status = 'unavailable';
      reason = `calibration_error:${err instanceof Error ? err.message : String(err)}`;
    }

    const baseFit = Number(r.strategy_fit_score ?? 0);
    const calibratedFit =
      res && Number.isFinite(baseFit)
        ? Math.max(0, Math.min(100, baseFit * res.fit_multiplier))
        : null;

    await supabase
      .from('coin_admission_results')
      .update({
        calibration_score: res?.score ?? null,
        calibration_confidence: res?.confidence ?? null,
        calibration_label: res?.label ?? null,
        calibration_neighbors: (res?.neighbors ?? null) as any,
        calibrated_strategy_fit: calibratedFit,
        calibration_strategy_version: strategyVersion,
        calibration_status: status,
        calibration_reason: reason,
        calibration_computed_at: computedAt,
      })
      .eq('id', r.id);

    if (status === 'ok') okCount += 1;
    else unavailableCount += 1;
  }

  return {
    rows_ok: okCount,
    rows_unavailable: unavailableCount,
    observations_used: observations.length,
  };
}
