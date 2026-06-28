/**
 * Backtest Calibration — server functions.
 *
 * Backtest results are append-only observations. createBacktestResult ALWAYS
 * inserts a new row; updateBacktestResult is only for explicit edits of an
 * existing row.
 */

import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  calibrateCandidate,
  extractFeatures,
  computeFeatureMedians,
  computeFeatureStds,
  autoSuggestLabel,
  computeBacktestQualityScore,
  detectNeedsReview,
  LABEL_CONFIG_VERSION,
  DEFAULT_CLASSIFICATION_THRESHOLDS,
  type BacktestLabel,
  type CalibrationConfig,
  type CalibrationResult,
  type ClassificationThresholds,
  type Observation,
  type ScreenerSnapshot,
} from './scoring';
import { computeSizingDerived, withSizingDefaults } from './sizing';

// ── Validators ────────────────────────────────────────────────────────────

const LabelEnum = z.enum(['no_trades', 'rejected_backtest', 'marginal', 'profitable', 'profitable_plus']);

const NumericNullable = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });
const IntNullable = NumericNullable.transform((v) => (v == null ? null : Math.round(v)));

const BacktestPayload = z.object({
  symbol: z.string().min(1).max(40),
  test_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strategy_version: z.string().min(1).max(80),
  admission_result_id: z.string().uuid().nullable().optional(),
  admission_run_id: z.string().uuid().nullable().optional(),
  screener_snapshot: z.record(z.any()).nullable().optional(),
  timeframe: z.string().max(8).default('5m'),
  candles_tested: z.number().int().min(0).default(9000),
  lookback_equivalent_days: NumericNullable.optional(),

  net_profit_pct: NumericNullable.optional(),
  net_profit_usd: NumericNullable.optional(),
  max_drawdown_pct: NumericNullable.optional(),
  max_drawdown_usd: NumericNullable.optional(),
  profit_factor: NumericNullable.optional(),
  win_rate_pct: NumericNullable.optional(),
  num_trades: IntNullable.optional(),
  avg_pnl_pct: NumericNullable.optional(),
  avg_bars_in_trade: NumericNullable.optional(),
  expected_payoff_usd: NumericNullable.optional(),
  sharpe_ratio: NumericNullable.optional(),
  largest_profit_usd: NumericNullable.optional(),
  largest_loss_usd: NumericNullable.optional(),
  profitable_trades_count: IntNullable.optional(),
  losing_trades_count: IntNullable.optional(),

  // Sizing & leverage assumptions (defaults applied server-side if missing)
  initial_capital_usd: NumericNullable.optional(),
  position_size_type: z.enum(['percent_of_equity']).optional(),
  position_size_pct: NumericNullable.optional(),
  position_size_usd: NumericNullable.optional(),
  leverage: NumericNullable.optional(),
  leverage_enabled: z.boolean().optional(),
  sizing_assumption_source: z
    .enum(['default_backfill', 'user_confirmed', 'imported_from_screenshot', 'manual_override'])
    .optional(),

  label: LabelEnum,
  notes: z.string().max(2000).nullable().optional(),

  screenshot_storage_path: z.string().max(500).nullable().optional(),
  extraction_source: z.enum(['manual', 'screenshot_ocr']).default('manual'),
  extraction_status: z.enum(['manual', 'confirmed']).default('manual'),
  extraction_confidence: NumericNullable.optional(),
  extracted_raw_text: z.string().max(4000).nullable().optional(),
  extracted_metrics: z.record(z.any()).nullable().optional(),
  field_confidences: z.record(z.any()).nullable().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────

async function loadCalibrationConfig(
  supabase: SupabaseClient,
): Promise<
  CalibrationConfig & {
    ocr_model: string;
    default_strategy_version: string | null;
    exclude_no_trades: boolean;
    exclude_needs_review: boolean;
  }
> {
  const { data } = await supabase
    .from('app_settings')
    .select(
      'calibration_half_life_days, calibration_k, calibration_min_neighbors_medium, calibration_min_neighbors_high, calibration_default_strategy_version, calibration_ocr_model, calibration_exclude_no_trades, calibration_exclude_needs_review',
    )
    .eq('singleton', true)
    .maybeSingle();
  return {
    k: data?.calibration_k ?? 10,
    half_life_days: data?.calibration_half_life_days ?? 180,
    min_neighbors_medium: data?.calibration_min_neighbors_medium ?? 4,
    min_neighbors_high: data?.calibration_min_neighbors_high ?? 10,
    ocr_model: data?.calibration_ocr_model ?? 'google/gemini-3-flash-preview',
    default_strategy_version: data?.calibration_default_strategy_version ?? null,
    exclude_no_trades: data?.calibration_exclude_no_trades ?? true,
    exclude_needs_review: data?.calibration_exclude_needs_review ?? true,
  };
}

async function loadClassificationThresholds(
  supabase: SupabaseClient,
): Promise<ClassificationThresholds> {
  // We still read from app_settings for backwards-compat with the v2 keys, but
  // the schema-bound defaults now drive the strategy-aware buckets. Anything
  // not present in app_settings falls through to the new defaults.
  const { data } = await supabase
    .from('app_settings')
    .select(
      'backtest_min_trades, backtest_marginal_min_profit_factor, backtest_profitable_min_profit_factor, backtest_profitable_plus_min_profit_factor, backtest_profitable_min_normalized_net_profit_pct, backtest_profitable_plus_min_normalized_net_profit_pct, backtest_max_leverage_adjusted_drawdown_profitable, backtest_max_leverage_adjusted_drawdown_profitable_plus',
    )
    .eq('singleton', true)
    .maybeSingle();
  const d = DEFAULT_CLASSIFICATION_THRESHOLDS;
  const legacyMinTrades = (data as any)?.backtest_min_trades;
  return {
    // Strategy-aware sample thresholds. Legacy `backtest_min_trades` (if set)
    // only acts as a floor for Profitable+; it does NOT raise the Profitable
    // floor any more (avoids the hard 20-trade penalty against DEXE/NEAR).
    profitable_min_trades: d.profitable_min_trades,
    profitable_plus_min_trades: Math.max(
      d.profitable_plus_min_trades,
      typeof legacyMinTrades === 'number' && legacyMinTrades > d.profitable_plus_min_trades
        ? legacyMinTrades
        : d.profitable_plus_min_trades,
    ),
    marginal_min_profit_factor:
      (data as any)?.backtest_marginal_min_profit_factor ?? d.marginal_min_profit_factor,
    profitable_min_profit_factor:
      (data as any)?.backtest_profitable_min_profit_factor ?? d.profitable_min_profit_factor,
    profitable_plus_min_profit_factor:
      (data as any)?.backtest_profitable_plus_min_profit_factor ?? d.profitable_plus_min_profit_factor,
    profitable_min_win_rate_pct: d.profitable_min_win_rate_pct,
    profitable_plus_min_win_rate_pct: d.profitable_plus_min_win_rate_pct,
    profitable_min_normalized_net_profit_pct:
      (data as any)?.backtest_profitable_min_normalized_net_profit_pct ??
      d.profitable_min_normalized_net_profit_pct,
    profitable_plus_min_normalized_net_profit_pct:
      (data as any)?.backtest_profitable_plus_min_normalized_net_profit_pct ??
      d.profitable_plus_min_normalized_net_profit_pct,
    max_leverage_adjusted_drawdown_profitable:
      (data as any)?.backtest_max_leverage_adjusted_drawdown_profitable ??
      d.max_leverage_adjusted_drawdown_profitable,
    max_leverage_adjusted_drawdown_profitable_plus:
      (data as any)?.backtest_max_leverage_adjusted_drawdown_profitable_plus ??
      d.max_leverage_adjusted_drawdown_profitable_plus,
    profitable_plus_min_drawdown_control_ratio: d.profitable_plus_min_drawdown_control_ratio,
  };
}

function ageDays(testDate: string, now: Date = new Date()): number {
  const t = new Date(testDate + 'T00:00:00Z').getTime();
  const ms = now.getTime() - t;
  return Math.max(0, ms / 86_400_000);
}

async function loadObservations(
  supabase: SupabaseClient,
  strategyVersion: string | null,
  opts?: { exclude_no_trades?: boolean; exclude_needs_review?: boolean },
): Promise<Observation[]> {
  let q = supabase
    .from('coin_backtest_results')
    .select(
      'id, symbol, test_date, label, screener_snapshot, strategy_version, needs_review, label_source, ' +
        'num_trades, backtest_quality_score, sample_bucket, sample_confidence_weight',
    )
    .in('extraction_status', ['manual', 'confirmed'])
    .order('test_date', { ascending: false })
    .limit(2000);
  if (strategyVersion) q = q.eq('strategy_version', strategyVersion);
  const { data, error } = await q;
  if (error) throw new Error(`load_observations:${error.message}`);
  const excludeNoTrades = opts?.exclude_no_trades ?? true;
  const excludeNeedsReview = opts?.exclude_needs_review ?? true;
  return (data ?? [])
    .filter((r: any) => {
      if (excludeNoTrades && r.label === 'no_trades') return false;
      if (excludeNeedsReview && r.needs_review === true && r.label_source !== 'manual_override') return false;
      return true;
    })
    .map((r: any) => ({
      id: r.id,
      symbol: r.symbol,
      test_date: r.test_date,
      label: r.label as BacktestLabel,
      label_source: r.label_source ?? 'auto',
      age_days: ageDays(r.test_date),
      features: extractFeatures((r.screener_snapshot ?? {}) as ScreenerSnapshot),
      quality_score: r.backtest_quality_score != null ? Number(r.backtest_quality_score) : null,
      sample_bucket: (r.sample_bucket ?? null) as any,
      sample_confidence_weight:
        r.sample_confidence_weight != null ? Number(r.sample_confidence_weight) : null,
      num_trades: r.num_trades ?? null,
    }));
}


// ── Functions ─────────────────────────────────────────────────────────────

export const listBacktestResults = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        symbol: z.string().optional(),
        strategy_version: z.string().optional(),
        label: LabelEnum.optional(),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    let q = supabase
      .from('coin_backtest_results')
      .select('*', { count: 'exact' })
      .order('test_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(data.offset, data.offset + data.limit - 1);
    if (data.symbol) q = q.eq('symbol', data.symbol);
    if (data.strategy_version) q = q.eq('strategy_version', data.strategy_version);
    if (data.label) q = q.eq('label', data.label);
    const { data: rows, error, count } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [], total: count ?? 0 };
  });

export const listStrategyVersions = createServerFn({ method: 'GET' })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    // Last used by THIS user first, then global recency.
    const { data: mine } = await supabase
      .from('coin_backtest_results')
      .select('strategy_version, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    const { data: globalRows } = await supabase
      .from('coin_backtest_results')
      .select('strategy_version, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    const seen = new Set<string>();
    const versions: string[] = [];
    for (const r of [...(mine ?? []), ...(globalRows ?? [])]) {
      if (!r.strategy_version || seen.has(r.strategy_version)) continue;
      seen.add(r.strategy_version);
      versions.push(r.strategy_version);
    }
    const cfg = await loadCalibrationConfig(supabase);
    return {
      versions,
      last_used_by_user: mine?.[0]?.strategy_version ?? null,
      last_used_global: globalRows?.[0]?.strategy_version ?? null,
      default_fallback: cfg.default_strategy_version,
    };
  });

export const createBacktestResult = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => BacktestPayload.parse(i))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Apply sizing defaults & compute derived metrics. Originals untouched.
    const sizing = withSizingDefaults({
      position_size_type: data.position_size_type ?? null,
      position_size_pct: data.position_size_pct ?? null,
      leverage: data.leverage ?? null,
      leverage_enabled: data.leverage_enabled ?? null,
    });
    const derived = computeSizingDerived(sizing, {
      net_profit_pct: data.net_profit_pct,
      max_drawdown_pct: data.max_drawdown_pct,
      avg_pnl_pct: data.avg_pnl_pct,
    });

    const thresholds = await loadClassificationThresholds(supabase);
    const auto = autoSuggestLabel(
      {
        net_profit_pct: data.net_profit_pct,
        max_drawdown_pct: data.max_drawdown_pct,
        profit_factor: data.profit_factor,
        win_rate_pct: data.win_rate_pct,
        num_trades: data.num_trades,
        normalized_net_profit_pct: derived.normalized_net_profit_pct,
        normalized_drawdown_pct: derived.normalized_drawdown_pct,
        leverage_adjusted_net_profit_pct: derived.leverage_adjusted_net_profit_pct,
        leverage_adjusted_drawdown_pct: derived.leverage_adjusted_drawdown_pct,
      },
      thresholds,
    );

    // Strip helper-only sizing fields from `data` so we can re-add merged sizing
    const {
      position_size_type: _pst,
      position_size_pct: _psp,
      leverage: _lev,
      leverage_enabled: _le,
      ...rest
    } = data;

    // Detect whether user confirmed a label that disagrees with the suggestion
    const review = detectNeedsReview(data.label as BacktestLabel, auto);
    const labelSource = data.label === auto.label ? 'auto' : 'manual_override';

    const row = {
      user_id: userId,
      ...rest,
      initial_capital_usd: data.initial_capital_usd ?? 10000,
      position_size_type: sizing.position_size_type,
      position_size_pct: sizing.position_size_pct,
      position_size_usd: data.position_size_usd ?? null,
      leverage: sizing.leverage,
      leverage_enabled: sizing.leverage_enabled,
      notional_exposure_pct: derived.notional_exposure_pct,
      normalized_net_profit_pct: derived.normalized_net_profit_pct,
      normalized_drawdown_pct: derived.normalized_drawdown_pct,
      normalized_avg_trade_pct: derived.normalized_avg_trade_pct,
      leverage_adjusted_net_profit_pct: derived.leverage_adjusted_net_profit_pct,
      leverage_adjusted_drawdown_pct: derived.leverage_adjusted_drawdown_pct,
      sizing_assumption_source: data.sizing_assumption_source ?? 'user_confirmed',
      auto_suggested_label: auto.label,
      backtest_quality_score: auto.quality_score,
      classification_reason_codes: auto.reason_codes,
      classification_positive_drivers: auto.positive_drivers,
      classification_negative_drivers: auto.negative_drivers,
      classification_safety_overrides: auto.safety_overrides,
      classification_summary: auto.summary,
      sample_bucket: auto.sample_bucket,
      sample_confidence_weight: auto.sample_confidence_weight,
      label_source: labelSource,
      label_overridden_at: labelSource === 'manual_override' ? new Date().toISOString() : null,
      label_overridden_by: labelSource === 'manual_override' ? userId : null,
      label_config_version: LABEL_CONFIG_VERSION,
      needs_review: review.needs_review,
      needs_review_reason: review.reason,
    };
    const { data: inserted, error } = await supabase
      .from('coin_backtest_results')
      .insert(row as any)

      .select('*')
      .single();
    if (error) {
      const isDupe = /duplicate key|unique constraint/i.test(error.message);
      throw new Error(
        isDupe
          ? 'duplicate_observation: Du har allerede registrert et resultat for samme symbol, strategy_version, test_date og admission-rad. Endre test_date eller åpne eksisterende rad for redigering.'
          : error.message,
      );
    }
    return { row: inserted, suggested: auto };
  });

export const updateBacktestResult = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        patch: BacktestPayload.partial(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: updated, error } = await supabase
      .from('coin_backtest_results')
      .update(data.patch as any)
      .eq('id', data.id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return { row: updated };
  });

/**
 * Update sizing/leverage assumptions only. Recomputes derived metrics.
 * Never touches the original TradingView numbers. Sets sizing source to
 * `manual_override` unless the caller specifies otherwise.
 */
export const updateBacktestSizing = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        sizing: z.object({
          initial_capital_usd: NumericNullable.optional(),
          position_size_type: z.enum(['percent_of_equity']).optional(),
          position_size_pct: NumericNullable.optional(),
          position_size_usd: NumericNullable.optional(),
          leverage: NumericNullable.optional(),
          leverage_enabled: z.boolean().optional(),
          sizing_assumption_source: z
            .enum([
              'default_backfill',
              'user_confirmed',
              'imported_from_screenshot',
              'manual_override',
            ])
            .optional(),
        }),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: row, error: rErr } = await supabase
      .from('coin_backtest_results')
      .select('net_profit_pct, max_drawdown_pct, avg_pnl_pct')
      .eq('id', data.id)
      .single();
    if (rErr) throw new Error(rErr.message);

    const sizing = withSizingDefaults({
      position_size_type: data.sizing.position_size_type ?? null,
      position_size_pct: data.sizing.position_size_pct ?? null,
      leverage: data.sizing.leverage ?? null,
      leverage_enabled: data.sizing.leverage_enabled ?? null,
    });
    const derived = computeSizingDerived(sizing, {
      net_profit_pct: row.net_profit_pct,
      max_drawdown_pct: row.max_drawdown_pct,
      avg_pnl_pct: row.avg_pnl_pct,
    });

    const patch: Record<string, unknown> = {
      initial_capital_usd: data.sizing.initial_capital_usd ?? undefined,
      position_size_type: sizing.position_size_type,
      position_size_pct: sizing.position_size_pct,
      position_size_usd: data.sizing.position_size_usd ?? null,
      leverage: sizing.leverage,
      leverage_enabled: sizing.leverage_enabled,
      notional_exposure_pct: derived.notional_exposure_pct,
      normalized_net_profit_pct: derived.normalized_net_profit_pct,
      normalized_drawdown_pct: derived.normalized_drawdown_pct,
      normalized_avg_trade_pct: derived.normalized_avg_trade_pct,
      leverage_adjusted_net_profit_pct: derived.leverage_adjusted_net_profit_pct,
      leverage_adjusted_drawdown_pct: derived.leverage_adjusted_drawdown_pct,
      sizing_assumption_source: data.sizing.sizing_assumption_source ?? 'manual_override',
    };
    // Drop undefined keys so we don't blank columns by mistake
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];

    const { data: updated, error } = await supabase
      .from('coin_backtest_results')
      .update(patch as any)
      .eq('id', data.id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return { row: updated, warnings: derived.warnings };
  });

export const deleteBacktestResult = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase.from('coin_backtest_results').delete().eq('id', data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getBacktestScreenshotUrl = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: row, error } = await supabase
      .from('coin_backtest_results')
      .select('screenshot_storage_path')
      .eq('id', data.id)
      .single();
    if (error) throw new Error(error.message);
    if (!row.screenshot_storage_path) return { url: null };
    const { data: signed, error: sErr } = await supabase.storage
      .from('backtest-screenshots')
      .createSignedUrl(row.screenshot_storage_path, 60 * 60); // 1h
    if (sErr) throw new Error(sErr.message);
    return { url: signed?.signedUrl ?? null };
  });

export const extractScreenshot = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ storage_path: z.string().min(1) }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const cfg = await loadCalibrationConfig(supabase);
    // Download the screenshot bytes server-side, send as data URL to the model
    // so we never rely on a public URL during extraction.
    const { data: blob, error: dlErr } = await supabase.storage
      .from('backtest-screenshots')
      .download(data.storage_path);
    if (dlErr || !blob) {
      return {
        ok: false,
        error: `download_failed:${dlErr?.message ?? 'no_blob'}`,
        extraction: null,
      };
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
    const mime = blob.type || 'image/png';
    const dataUrl = `data:${mime};base64,${b64}`;

    const { extractTradingViewMetrics } = await import('./ocr.server');
    const extraction = await extractTradingViewMetrics(dataUrl, cfg.ocr_model);
    return { ok: extraction.ok, error: extraction.error, extraction };
  });

/**
 * Calibrate every result in a finished admission run, write columns back to
 * coin_admission_results. Per-symbol best-effort: a failure marks the row as
 * `calibration_status='unavailable'` but never aborts.
 */
export const runCalibrationForRun = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        run_id: z.string().uuid(),
        strategy_version: z.string().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const cfg = await loadCalibrationConfig(supabase);

    const observations = await loadObservations(supabase, data.strategy_version ?? null);
    const observationsAny = observations.length > 0;
    const featureRows = observations.map((o) => o.features);
    const medians = computeFeatureMedians(featureRows);
    const stds = computeFeatureStds(featureRows, medians);

    const { data: rows, error } = await supabase
      .from('coin_admission_results')
      .select(
        'id, symbol, score, historical_trend_quality, htq_components, current_momentum_score, turnover_24h, turnover_7d_median, open_interest_value, spread_bps, listing_age_days, strategy_fit_score',
      )
      .eq('run_id', data.run_id);
    if (error) throw new Error(error.message);

    let okCount = 0;
    let unavailableCount = 0;
    const computedAt = new Date().toISOString();

    for (const r of rows ?? []) {
      let res: CalibrationResult | null = null;
      let status: 'ok' | 'unavailable' = 'ok';
      let reason: string | null = null;
      try {
        if (!observationsAny) {
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

      const { error: upErr } = await supabase
        .from('coin_admission_results')
        .update({
          calibration_score: res?.score ?? null,
          calibration_confidence: res?.confidence ?? null,
          calibration_label: res?.label ?? null,
          calibration_neighbors: (res?.neighbors ?? null) as any,
          calibrated_strategy_fit: calibratedFit,
          calibration_strategy_version: data.strategy_version ?? null,
          calibration_status: status,
          calibration_reason: reason,
          calibration_computed_at: computedAt,
        })
        .eq('id', r.id);
      if (upErr) {
        // Don't throw — best-effort
        unavailableCount += 1;
        continue;
      }
      if (status === 'ok') okCount += 1;
      else unavailableCount += 1;
    }

    return {
      ok: true,
      observations_used: observations.length,
      rows_ok: okCount,
      rows_unavailable: unavailableCount,
      strategy_version: data.strategy_version ?? null,
      half_life_days: cfg.half_life_days,
      k: cfg.k,
    };
  });

export const getCalibrationConfig = createServerFn({ method: 'GET' })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    return await loadCalibrationConfig(context.supabase);
  });

export const updateCalibrationConfig = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        calibration_half_life_days: z.number().int().min(7).max(3650).optional(),
        calibration_k: z.number().int().min(1).max(50).optional(),
        calibration_min_neighbors_medium: z.number().int().min(1).max(50).optional(),
        calibration_min_neighbors_high: z.number().int().min(1).max(50).optional(),
        calibration_default_strategy_version: z.string().max(80).nullable().optional(),
        calibration_ocr_model: z.string().min(1).max(80).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from('app_settings')
      .update(data)
      .eq('singleton', true);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Latest backtest observation per symbol (for the calling user), plus total
 * count. Used by the admission table to render "Last Backtest" columns
 * without N round-trips. Scoped to small symbol batches (≤ ~300).
 */
export const listLatestBacktestPerSymbol = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        symbols: z.array(z.string().min(1).max(40)).min(1).max(2000),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase
      .from('coin_backtest_results')
      .select(
        'id, symbol, test_date, label, strategy_version, created_at, ' +
          'auto_suggested_label, label_source, needs_review, needs_review_reason, ' +
          'backtest_quality_score, classification_summary, ' +
          'classification_positive_drivers, classification_negative_drivers, ' +
          'classification_safety_overrides, ' +
          'net_profit_pct, normalized_net_profit_pct, leverage_adjusted_net_profit_pct, ' +
          'profit_factor, win_rate_pct, max_drawdown_pct, num_trades',
      )
      .eq('user_id', userId)
      .in('symbol', data.symbols)
      .order('test_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) throw new Error(error.message);
    type Entry = {
      symbol: string;
      last_test_date: string | null;
      last_label: string | null;
      last_strategy_version: string | null;
      count: number;
      last_auto_suggested_label: string | null;
      last_label_source: string | null;
      last_needs_review: boolean | null;
      last_needs_review_reason: string | null;
      last_bt_score: number | null;
      last_summary: string | null;
      // jsonb shape varies (string | array | object); typed loose for the serializer.
      last_positive_drivers: any;
      last_negative_drivers: any;
      last_safety_overrides: string[] | null;
      last_net_profit_pct: number | null;
      last_normalized_net_profit_pct: number | null;
      last_leverage_adjusted_net_profit_pct: number | null;
      last_profit_factor: number | null;
      last_win_rate_pct: number | null;
      last_max_drawdown_pct: number | null;
      last_num_trades: number | null;
    };
    const map: Record<string, Entry> = {};
    for (const r of (rows ?? []) as any[]) {
      const cur = map[r.symbol];
      if (!cur) {
        map[r.symbol] = {
          symbol: r.symbol,
          last_test_date: r.test_date,
          last_label: r.label,
          last_strategy_version: r.strategy_version,
          count: 1,
          last_auto_suggested_label: r.auto_suggested_label ?? null,
          last_label_source: r.label_source ?? null,
          last_needs_review: r.needs_review ?? null,
          last_needs_review_reason: r.needs_review_reason ?? null,
          last_bt_score: r.backtest_quality_score != null ? Number(r.backtest_quality_score) : null,
          last_summary: r.classification_summary ?? null,
      last_positive_drivers: (r.classification_positive_drivers ?? null) as any,
      last_negative_drivers: (r.classification_negative_drivers ?? null) as any,
      last_safety_overrides: (r.classification_safety_overrides ?? null) as string[] | null,
          last_net_profit_pct: r.net_profit_pct != null ? Number(r.net_profit_pct) : null,
          last_normalized_net_profit_pct:
            r.normalized_net_profit_pct != null ? Number(r.normalized_net_profit_pct) : null,
          last_leverage_adjusted_net_profit_pct:
            r.leverage_adjusted_net_profit_pct != null
              ? Number(r.leverage_adjusted_net_profit_pct)
              : null,
          last_profit_factor: r.profit_factor != null ? Number(r.profit_factor) : null,
          last_win_rate_pct: r.win_rate_pct != null ? Number(r.win_rate_pct) : null,
          last_max_drawdown_pct: r.max_drawdown_pct != null ? Number(r.max_drawdown_pct) : null,
          last_num_trades: r.num_trades ?? null,
        };
      } else {
        cur.count += 1;
      }
    }
    return { per_symbol: map };
  });

/**
 * Recalculate calibration for a single admission row (one symbol in one run).
 * Reuses the same scoring path as a full-run calibration so results stay
 * consistent. Best-effort: marks the row `unavailable` on failure rather than
 * throwing to the UI.
 */
export const recalcCalibrationForSymbol = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        run_id: z.string().uuid(),
        symbol: z.string().min(1).max(40),
        strategy_version: z.string().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const cfg = await loadCalibrationConfig(supabase);
    const observations = await loadObservations(
      supabase,
      data.strategy_version ?? null,
    );
    const featureRows = observations.map((o) => o.features);
    const medians = computeFeatureMedians(featureRows);
    const stds = computeFeatureStds(featureRows, medians);

    const { data: row, error } = await supabase
      .from('coin_admission_results')
      .select(
        'id, symbol, score, historical_trend_quality, htq_components, current_momentum_score, turnover_24h, turnover_7d_median, open_interest_value, spread_bps, listing_age_days, strategy_fit_score',
      )
      .eq('run_id', data.run_id)
      .eq('symbol', data.symbol)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error('admission_row_not_found');

    let res: CalibrationResult | null = null;
    let status: 'ok' | 'unavailable' = 'ok';
    let reason: string | null = null;
    try {
      if (observations.length === 0) {
        status = 'unavailable';
        reason = 'no_observations';
      } else {
        const candFeatures = extractFeatures({
          robustness: row.score,
          historical_trend_quality: row.historical_trend_quality,
          htq_components: row.htq_components as any,
          current_momentum_score: row.current_momentum_score,
          turnover_24h: row.turnover_24h,
          turnover_7d_median: row.turnover_7d_median,
          open_interest_value: row.open_interest_value,
          spread_bps: row.spread_bps,
          listing_age_days: row.listing_age_days,
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

    const baseFit = Number(row.strategy_fit_score ?? 0);
    const calibratedFit =
      res && Number.isFinite(baseFit)
        ? Math.max(0, Math.min(100, baseFit * res.fit_multiplier))
        : null;

    const computedAt = new Date().toISOString();
    const { error: upErr } = await supabase
      .from('coin_admission_results')
      .update({
        calibration_score: res?.score ?? null,
        calibration_confidence: res?.confidence ?? null,
        calibration_label: res?.label ?? null,
        calibration_neighbors: (res?.neighbors ?? null) as any,
        calibrated_strategy_fit: calibratedFit,
        calibration_strategy_version: data.strategy_version ?? null,
        calibration_status: status,
        calibration_reason: reason,
        calibration_computed_at: computedAt,
      })
      .eq('id', row.id);
    if (upErr) throw new Error(upErr.message);

    return {
      ok: true,
      status,
      reason,
      calibration_score: res?.score ?? null,
      calibration_label: res?.label ?? null,
      observations_used: observations.length,
    };
  });
