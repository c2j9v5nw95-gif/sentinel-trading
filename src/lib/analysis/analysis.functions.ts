/**
 * Analysis dataset — server function that returns the latest backtest row per
 * (symbol, strategy_version, timeframe) with a flattened screener_snapshot.
 *
 * Read-only. Does not touch execution, sizing, dispatcher or signals.
 */

import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';

export type AnalysisLabel =
  | 'no_trades'
  | 'rejected_backtest'
  | 'marginal'
  | 'profitable'
  | 'profitable_plus';

export const TOP_LEVEL_FEATURES = [
  'historical_trend_quality',
  'current_momentum_score',
  'strategy_fit_score',
  'robustness',
  'turnover_24h',
  'turnover_7d_median',
  'open_interest_value',
  'spread_bps',
  'listing_age_days',
] as const;

export const HTQ_COMPONENT_FEATURES = [
  'smoothness',
  'wick_penalty',
  'flips_per_day',
  'mtf_alignment',
  'mtf_alignment_pct',
  'trend_runs_1h',
  'flip_frequency',
  'persistence_1h',
  'trend_time_pct',
  'tradeability_5m',
  'median_efficiency',
  'wick_pct_during_trends',
  'median_trend_duration_hours',
] as const;

export type FeatureKey =
  | (typeof TOP_LEVEL_FEATURES)[number]
  | (typeof HTQ_COMPONENT_FEATURES)[number];

export const ALL_FEATURES: FeatureKey[] = [
  ...TOP_LEVEL_FEATURES,
  ...HTQ_COMPONENT_FEATURES,
];

export interface AnalysisRow {
  id: string;
  symbol: string;
  test_date: string;
  strategy_version: string;
  timeframe: string;
  label: AnalysisLabel | null;
  auto_suggested_label: AnalysisLabel | null;
  label_source: string | null;
  needs_review: boolean;
  num_trades: number | null;
  net_profit_pct: number | null;
  net_profit_usd: number | null;
  max_drawdown_pct: number | null;
  profit_factor: number | null;
  win_rate_pct: number | null;
  backtest_quality_score: number | null;
  normalized_net_profit_pct: number | null;
  htq_mode: string | null;
  features: Record<string, number | null>;
  excluded: boolean;
  excluded_reason?: string;
}

export interface AnalysisDataset {
  rows: AnalysisRow[];
  meta: {
    total: number;
    included: number;
    excluded: number;
    strategies: string[];
    timeframes: string[];
    generated_at: string;
    filter: {
      strategy_version: string | null;
      timeframe: string | null;
      min_trades: number;
    };
  };
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export const getAnalysisDataset = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        strategy_version: z.string().nullable().optional(),
        timeframe: z.string().nullable().optional(),
        min_trades: z.number().int().min(0).max(1000).default(0),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }): Promise<AnalysisDataset> => {
    const { supabase, userId } = context;

    let q = supabase
      .from('coin_backtest_results')
      .select(
        [
          'id',
          'symbol',
          'test_date',
          'strategy_version',
          'timeframe',
          'label',
          'auto_suggested_label',
          'label_source',
          'needs_review',
          'num_trades',
          'net_profit_pct',
          'net_profit_usd',
          'max_drawdown_pct',
          'profit_factor',
          'win_rate_pct',
          'backtest_quality_score',
          'normalized_net_profit_pct',
          'screener_snapshot',
        ].join(','),
      )
      .eq('user_id', userId)
      .order('symbol', { ascending: true })
      .order('test_date', { ascending: false })
      .limit(5000);

    if (data.strategy_version) q = q.eq('strategy_version', data.strategy_version);
    if (data.timeframe) q = q.eq('timeframe', data.timeframe);

    const { data: raw, error } = await q;
    if (error) throw new Error(error.message);

    const seen = new Set<string>();
    const strategies = new Set<string>();
    const timeframes = new Set<string>();
    const rows: AnalysisRow[] = [];
    let excluded = 0;

    for (const r of (raw ?? []) as any[]) {
      strategies.add(r.strategy_version);
      timeframes.add(r.timeframe ?? '5m');
      const key = `${r.symbol}::${r.strategy_version}::${r.timeframe ?? '5m'}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const snap = (r.screener_snapshot ?? {}) as Record<string, any>;
      const htq = (snap.htq_components ?? {}) as Record<string, any>;
      const features: Record<string, number | null> = {};
      for (const k of TOP_LEVEL_FEATURES) features[k] = toNum(snap[k]);
      for (const k of HTQ_COMPONENT_FEATURES) features[k] = toNum(htq[k]);

      const numTrades = toNum(r.num_trades);
      const isAuto = (r.label_source ?? 'auto') === 'auto';
      let excluded_reason: string | undefined;
      if (r.label === 'no_trades' || (numTrades ?? 0) === 0) {
        excluded_reason = 'no_trades';
      } else if (r.needs_review && isAuto) {
        excluded_reason = 'needs_review_auto';
      } else if ((numTrades ?? 0) < data.min_trades) {
        excluded_reason = `min_trades<${data.min_trades}`;
      }
      const isExcluded = Boolean(excluded_reason);
      if (isExcluded) excluded++;

      rows.push({
        id: r.id,
        symbol: r.symbol,
        test_date: r.test_date,
        strategy_version: r.strategy_version,
        timeframe: r.timeframe ?? '5m',
        label: r.label ?? null,
        auto_suggested_label: r.auto_suggested_label ?? null,
        label_source: r.label_source ?? null,
        needs_review: Boolean(r.needs_review),
        num_trades: numTrades,
        net_profit_pct: toNum(r.net_profit_pct),
        net_profit_usd: toNum(r.net_profit_usd),
        max_drawdown_pct: toNum(r.max_drawdown_pct),
        profit_factor: toNum(r.profit_factor),
        win_rate_pct: toNum(r.win_rate_pct),
        backtest_quality_score: toNum(r.backtest_quality_score),
        normalized_net_profit_pct: toNum(r.normalized_net_profit_pct),
        htq_mode: (snap.htq_mode as string) ?? null,
        features,
        excluded: isExcluded,
        excluded_reason,
      });
    }

    return {
      rows,
      meta: {
        total: rows.length,
        included: rows.length - excluded,
        excluded,
        strategies: [...strategies].sort(),
        timeframes: [...timeframes].sort(),
        generated_at: new Date().toISOString(),
        filter: {
          strategy_version: data.strategy_version ?? null,
          timeframe: data.timeframe ?? null,
          min_trades: data.min_trades,
        },
      },
    };
  });
