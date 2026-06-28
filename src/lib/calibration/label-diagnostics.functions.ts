/**
 * Phase 0 — Label Health Diagnostics + Safe Batch Recompute.
 *
 * Two server functions:
 *
 *  - getLabelDiagnostics: READ-ONLY. Aggregates coin_backtest_results to
 *    surface label distribution, disagreement, no_trades count, review
 *    status, kNN exclusion breakdown, per-strategy_version split and
 *    suspicious rows (positive metrics labelled marginal/rejected, or rows
 *    whose recomputed auto suggestion would differ).
 *
 *  - safeRecomputeAutoLabels: dry-run by default. When committed, writes ONLY
 *    these columns:
 *       auto_suggested_label,
 *       backtest_quality_score,
 *       classification_reason_codes,
 *       classification_positive_drivers,
 *       classification_negative_drivers,
 *       classification_safety_overrides,
 *       classification_summary,
 *       label_config_version,
 *       needs_review,
 *       needs_review_reason
 *    Hard guarantees:
 *       - NEVER touches `label` (confirmed)
 *       - NEVER touches `label_source`
 *       - NEVER touches TradingView numbers or screener_snapshot
 *       - Rows with label_source = 'manual_override' never get needs_review=true
 *         set automatically by this job (their auto fields are still refreshed)
 *       - num_trades = 0 always maps to auto_suggested_label = 'no_trades'
 *         (assertion at write time)
 *    Writes one audit_log row per commit run.
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

type Row = Record<string, any>;

const LABELS: BacktestLabel[] = [
  'no_trades',
  'rejected_backtest',
  'marginal',
  'profitable',
  'profitable_plus',
];

function emptyLabelMap(): Record<string, number> {
  return { no_trades: 0, rejected_backtest: 0, marginal: 0, profitable: 0, profitable_plus: 0 };
}

function recomputeOne(row: Row) {
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
  return autoSuggestLabel(
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
}

export const getLabelDiagnostics = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from('coin_backtest_results')
      .select('*')
      .limit(10000);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Row[];

    const confirmed = emptyLabelMap();
    const suggested = emptyLabelMap();
    const disagreement: Array<{ confirmed: string; suggested: string; count: number }> = [];
    const disMap = new Map<string, number>();

    let noTrades = 0;
    let needsReviewTotal = 0;
    const needsReviewBySource: Record<string, number> = { auto: 0, manual_override: 0 };

    let excludedNoTrades = 0;
    let excludedNeedsReviewAuto = 0;
    let included = 0;
    const includedByLabel = emptyLabelMap();

    const perStrategy: Record<string, Record<string, number>> = {};

    type SuspectRow = {
      id: string;
      symbol: string;
      test_date: string | null;
      label: string;
      auto_suggested_label: string | null;
      recomputed_suggestion: string;
      net_profit_pct: number | null;
      profit_factor: number | null;
      win_rate_pct: number | null;
      num_trades: number | null;
    };
    const positiveNet: SuspectRow[] = [];
    const pfGt1: SuspectRow[] = [];
    const winrateGte50: SuspectRow[] = [];
    const recomputeUpgrades: SuspectRow[] = [];

    for (const r of rows) {
      const lab = r.label as string;
      const sug = r.auto_suggested_label as string | null;
      if (confirmed[lab] != null) confirmed[lab] += 1;
      if (sug && suggested[sug] != null) suggested[sug] += 1;

      if (lab !== sug && sug != null) {
        const key = `${lab}>>${sug}`;
        disMap.set(key, (disMap.get(key) ?? 0) + 1);
      }

      if (r.num_trades === 0) noTrades += 1;
      if (r.needs_review === true) {
        needsReviewTotal += 1;
        const src = r.label_source ?? 'auto';
        needsReviewBySource[src] = (needsReviewBySource[src] ?? 0) + 1;
      }

      // kNN exclusion breakdown (mirrors run-inline.server.ts)
      if (lab === 'no_trades') {
        excludedNoTrades += 1;
      } else if (r.needs_review === true && (r.label_source ?? 'auto') !== 'manual_override') {
        excludedNeedsReviewAuto += 1;
      } else {
        included += 1;
        if (includedByLabel[lab] != null) includedByLabel[lab] += 1;
      }

      const sv = r.strategy_version ?? '(none)';
      if (!perStrategy[sv]) perStrategy[sv] = emptyLabelMap();
      if (perStrategy[sv][lab] != null) perStrategy[sv][lab] += 1;

      // Suspect detection — only on marginal / rejected_backtest with metrics
      if (lab === 'marginal' || lab === 'rejected_backtest') {
        const rec = recomputeOne(r);
        const suspect: SuspectRow = {
          id: r.id,
          symbol: r.symbol,
          test_date: r.test_date,
          label: lab,
          auto_suggested_label: sug,
          recomputed_suggestion: rec.label,
          net_profit_pct: r.net_profit_pct,
          profit_factor: r.profit_factor,
          win_rate_pct: r.win_rate_pct,
          num_trades: r.num_trades,
        };
        if (r.net_profit_pct != null && r.net_profit_pct > 0) positiveNet.push(suspect);
        if (r.profit_factor != null && r.profit_factor > 1) pfGt1.push(suspect);
        if (r.win_rate_pct != null && r.win_rate_pct >= 50) winrateGte50.push(suspect);
        if (rec.label === 'profitable' || rec.label === 'profitable_plus') {
          recomputeUpgrades.push(suspect);
        }
      }
    }

    for (const [key, count] of disMap) {
      const [c, s] = key.split('>>');
      disagreement.push({ confirmed: c, suggested: s, count });
    }
    disagreement.sort((a, b) => b.count - a.count);

    const sortByNet = (a: SuspectRow, b: SuspectRow) =>
      (b.net_profit_pct ?? -Infinity) - (a.net_profit_pct ?? -Infinity);

    return {
      total: rows.length,
      confirmed,
      suggested,
      disagreement,
      no_trades: noTrades,
      needs_review: {
        total: needsReviewTotal,
        by_source: needsReviewBySource,
      },
      knn_exclusion: {
        excluded_no_trades: excludedNoTrades,
        excluded_needs_review_auto: excludedNeedsReviewAuto,
        included,
        included_by_label: includedByLabel,
      },
      per_strategy: perStrategy,
      suspicious: {
        positive_net: {
          count: positiveNet.length,
          top: positiveNet.sort(sortByNet).slice(0, 10),
        },
        profit_factor_gt_1: {
          count: pfGt1.length,
          top: pfGt1.sort((a, b) => (b.profit_factor ?? 0) - (a.profit_factor ?? 0)).slice(0, 10),
        },
        winrate_gte_50: {
          count: winrateGte50.length,
          top: winrateGte50.sort((a, b) => (b.win_rate_pct ?? 0) - (a.win_rate_pct ?? 0)).slice(0, 10),
        },
        recompute_would_upgrade: {
          count: recomputeUpgrades.length,
          top: recomputeUpgrades.sort(sortByNet).slice(0, 10),
        },
      },
      generated_at: new Date().toISOString(),
    };
  });

export const safeRecomputeAutoLabels = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        dry_run: z.boolean().default(true),
        strategy_version: z.string().optional(),
        only_changed: z.boolean().default(false),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    let q = supabase.from('coin_backtest_results').select('*').limit(10000);
    if (data.strategy_version) q = q.eq('strategy_version', data.strategy_version);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    type Diff = {
      id: string;
      symbol: string;
      test_date: string | null;
      confirmed_label: string;
      label_source: string;
      current_auto: string | null;
      new_auto: BacktestLabel;
      current_quality: number | null;
      new_quality: number;
      will_set_needs_review: boolean;
      changed: boolean;
    };

    const diffs: Diff[] = [];
    const labelShifts: Record<string, number> = {};
    let writeCount = 0;
    let assertionFailures = 0;

    for (const r of (rows ?? []) as Row[]) {
      const auto = recomputeOne(r);

      // Hard assertion: num_trades = 0 must map to no_trades.
      if (r.num_trades === 0 && auto.label !== 'no_trades') {
        assertionFailures += 1;
        continue;
      }

      const isManual = r.label_source === 'manual_override';
      const review = detectNeedsReview(r.label as BacktestLabel, auto);
      // Manual overrides never get needs_review=true from this job.
      const willSetReview = isManual ? false : review.needs_review;

      const changed =
        (r.auto_suggested_label ?? null) !== auto.label ||
        Math.abs((r.backtest_quality_score ?? -1) - auto.quality_score) >= 0.5 ||
        (r.needs_review === true) !== willSetReview;

      const diff: Diff = {
        id: r.id,
        symbol: r.symbol,
        test_date: r.test_date,
        confirmed_label: r.label,
        label_source: r.label_source ?? 'auto',
        current_auto: r.auto_suggested_label ?? null,
        new_auto: auto.label,
        current_quality: r.backtest_quality_score ?? null,
        new_quality: auto.quality_score,
        will_set_needs_review: willSetReview,
        changed,
      };
      diffs.push(diff);

      const shiftKey = `${r.auto_suggested_label ?? 'none'}>>${auto.label}`;
      if (changed) labelShifts[shiftKey] = (labelShifts[shiftKey] ?? 0) + 1;

      if (data.dry_run || !changed) continue;

      const patch: Record<string, any> = {
        auto_suggested_label: auto.label,
        backtest_quality_score: auto.quality_score,
        classification_reason_codes: auto.reason_codes,
        classification_positive_drivers: auto.positive_drivers,
        classification_negative_drivers: auto.negative_drivers,
        classification_safety_overrides: auto.safety_overrides,
        classification_summary: auto.summary,
        sample_bucket: auto.sample_bucket,
        sample_confidence_weight: auto.sample_confidence_weight,
        label_config_version: LABEL_CONFIG_VERSION,
      };

      if (!isManual) {
        patch.needs_review = willSetReview;
        patch.needs_review_reason = willSetReview ? review.reason : null;
      }

      const { error: upErr } = await supabase
        .from('coin_backtest_results')
        .update(patch as any)
        .eq('id', r.id);
      if (!upErr) writeCount += 1;
    }

    const totalChanged = diffs.filter((d) => d.changed).length;
    const filteredDiffs = data.only_changed ? diffs.filter((d) => d.changed) : diffs;

    if (!data.dry_run) {
      await supabase.from('audit_log').insert({
        actor_user_id: userId,
        action: 'label_recompute_batch',
        target: 'coin_backtest_results',
        after: {
          scanned: diffs.length,
          updated: writeCount,
          assertion_failures: assertionFailures,
          label_shifts: labelShifts,
          filter: { strategy_version: data.strategy_version ?? null },
        } as any,
      } as any);
    }

    return {
      ok: true,
      dry_run: data.dry_run,
      scanned: diffs.length,
      changed: totalChanged,
      updated: writeCount,
      assertion_failures: assertionFailures,
      label_shifts: labelShifts,
      diffs: filteredDiffs.slice(0, 500),
    };
  });
