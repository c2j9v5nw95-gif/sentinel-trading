/**
 * Phase 0 — Backtest Label Quality / Review server functions.
 *
 * - listLabelReview: paginated view of backtest rows with filters.
 * - recomputeSuggestedLabels: re-runs autoSuggest over existing rows. Never
 *   overwrites a `manual_override` confirmed label; updates auto rows in place
 *   and toggles `needs_review` when the new suggestion disagrees.
 * - overrideBacktestLabel: operator confirms a manual label; clears
 *   needs_review and stamps override metadata.
 */

import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import {
  autoSuggestLabel,
  detectNeedsReview,
  LABEL_CONFIG_VERSION,
  DEFAULT_CLASSIFICATION_THRESHOLDS,
  type BacktestLabel,
} from './scoring';
import { computeSizingDerived } from './sizing';

const LabelEnum = z.enum([
  'no_trades',
  'rejected_backtest',
  'marginal',
  'profitable',
  'profitable_plus',
]);

export const listLabelReview = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        only_needs_review: z.boolean().default(false),
        label: LabelEnum.nullable().optional(),
        strategy_version: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(200),
        offset: z.number().int().min(0).default(0),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    let q = supabase
      .from('coin_backtest_results')
      .select('*', { count: 'exact' })
      .order('needs_review', { ascending: false })
      .order('test_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(data.offset, data.offset + data.limit - 1);
    if (data.only_needs_review) q = q.eq('needs_review', true);
    if (data.label) q = q.eq('label', data.label);
    if (data.strategy_version) q = q.eq('strategy_version', data.strategy_version);
    const { data: rows, error, count } = await q;
    if (error) throw new Error(error.message);

    // Distribution snapshot for the header
    const { data: dist } = await supabase
      .from('coin_backtest_results')
      .select('label')
      .limit(5000);
    const distribution: Record<string, number> = {};
    for (const r of dist ?? []) {
      const k = (r as any).label as string;
      distribution[k] = (distribution[k] ?? 0) + 1;
    }
    return { rows: rows ?? [], total: count ?? 0, distribution };
  });

export const recomputeSuggestedLabels = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        strategy_version: z.string().optional(),
        symbol: z.string().optional(),
        dry_run: z.boolean().default(false),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    let q = supabase.from('coin_backtest_results').select('*').limit(5000);
    if (data.strategy_version) q = q.eq('strategy_version', data.strategy_version);
    if (data.symbol) q = q.eq('symbol', data.symbol);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    let updated = 0;
    let flagged = 0;
    let skipped_manual = 0;
    const changes: Array<{
      id: string;
      symbol: string;
      from_label: string;
      to_label: string;
      from_suggested: string | null;
      to_suggested: string;
      needs_review: boolean;
    }> = [];

    for (const r of rows ?? []) {
      const row = r as any;
      const derived = computeSizingDerived(
        {
          position_size_type: row.position_size_type,
          position_size_pct: row.position_size_pct,
          leverage: row.leverage,
          leverage_enabled: row.leverage_enabled,
        },
        {
          net_profit_pct: row.net_profit_pct,
          max_drawdown_pct: row.max_drawdown_pct,
          avg_pnl_pct: row.avg_pnl_pct,
        },
      );
      const auto = autoSuggestLabel(
        {
          net_profit_pct: row.net_profit_pct,
          max_drawdown_pct: row.max_drawdown_pct,
          profit_factor: row.profit_factor,
          win_rate_pct: row.win_rate_pct,
          num_trades: row.num_trades,
          normalized_net_profit_pct: derived.normalized_net_profit_pct,
          normalized_drawdown_pct: derived.normalized_drawdown_pct,
          leverage_adjusted_net_profit_pct: derived.leverage_adjusted_net_profit_pct,
          leverage_adjusted_drawdown_pct: derived.leverage_adjusted_drawdown_pct,
        },
        DEFAULT_CLASSIFICATION_THRESHOLDS,
      );

      const isManual = row.label_source === 'manual_override';
      // Manual overrides keep their confirmed label, but we still refresh
      // suggested/diagnostics and may flag for review.
      const nextLabel = isManual ? (row.label as BacktestLabel) : auto.label;
      const review = detectNeedsReview(nextLabel, auto);

      const patch: Record<string, any> = {
        auto_suggested_label: auto.label,
        backtest_quality_score: auto.quality_score,
        classification_reason_codes: auto.reason_codes,
        classification_positive_drivers: auto.positive_drivers,
        classification_negative_drivers: auto.negative_drivers,
        classification_safety_overrides: auto.safety_overrides,
        classification_summary: auto.summary,
        label_config_version: LABEL_CONFIG_VERSION,
        needs_review: review.needs_review,
        needs_review_reason: review.reason,
      };
      if (!isManual && row.label !== auto.label) {
        patch.label = auto.label;
      }

      changes.push({
        id: row.id,
        symbol: row.symbol,
        from_label: row.label,
        to_label: (patch.label as string) ?? row.label,
        from_suggested: row.auto_suggested_label ?? null,
        to_suggested: auto.label,
        needs_review: review.needs_review,
      });

      if (data.dry_run) continue;
      if (isManual) skipped_manual += 1;
      const { error: upErr } = await supabase
        .from('coin_backtest_results')
        .update(patch)
        .eq('id', row.id);
      if (upErr) continue;
      updated += 1;
      if (review.needs_review) flagged += 1;
    }

    return {
      ok: true,
      dry_run: data.dry_run,
      scanned: (rows ?? []).length,
      updated,
      flagged_needs_review: flagged,
      kept_manual_override: skipped_manual,
      changes: changes.slice(0, 200),
    };
  });

export const overrideBacktestLabel = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        label: LabelEnum,
        clear_review: z.boolean().default(true),
        note: z.string().max(500).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const patch: Record<string, any> = {
      label: data.label,
      label_source: 'manual_override',
      label_overridden_at: new Date().toISOString(),
      label_overridden_by: userId,
      label_config_version: LABEL_CONFIG_VERSION,
    };
    if (data.clear_review) {
      patch.needs_review = false;
      patch.needs_review_reason = data.note
        ? `Manually confirmed: ${data.note}`
        : 'Manually confirmed';
    }
    const { data: updated, error } = await supabase
      .from('coin_backtest_results')
      .update(patch)
      .eq('id', data.id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return { row: updated };
  });

export const clearNeedsReview = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from('coin_backtest_results')
      .update({ needs_review: false, needs_review_reason: 'Reviewed — kept current label' })
      .eq('id', data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
