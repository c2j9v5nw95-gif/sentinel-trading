import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import {
  fetchUniverse,
  fetchAllTickers,
  fetchCoinGeckoMarkets,
  fetchDailyKline,
  fetchHourlyKline,
  fetch5mKline,
  fetch15mKline,
  buildMetrics,
  pMapLimit,
  computeAdmissionScore,
  type AdmissionThresholds,
  type AdmissionWeights,
} from './admission.server';
import { computeTrendQuality } from './trend-quality';

const StartInput = z.object({
  profileId: z.string().uuid(),
  maxSymbols: z.number().int().min(1).max(2000).optional(),
  skipWickAnalysis: z.boolean().default(false),
  mode: z.enum(['strict', 'trend_adjusted']).default('strict'),
  includeTrendQuality: z.boolean().optional(),
});

export const startAdmissionRun = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => StartInput.parse(i))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const includeTrend = data.includeTrendQuality ?? (data.mode === 'trend_adjusted');

    const { data: profile, error: profErr } = await supabase
      .from('coin_admission_profiles')
      .select('id, name, thresholds, weights')
      .eq('id', data.profileId)
      .maybeSingle();
    if (profErr || !profile) throw new Error(`profile_not_found: ${profErr?.message ?? 'missing'}`);
    const thresholds = profile.thresholds as unknown as AdmissionThresholds;
    const weights = profile.weights as unknown as AdmissionWeights;

    const { data: runRow, error: runErr } = await supabase
      .from('coin_admission_runs')
      .insert({
        profile_id: profile.id,
        profile_name: profile.name,
        triggered_by: userId,
        status: 'running',
        admission_mode: data.mode,
        include_trend_quality: includeTrend,
      })
      .select('id')
      .single();
    if (runErr || !runRow) throw new Error(`run_insert_failed: ${runErr?.message}`);
    const runId = runRow.id as string;

    try {
      const [universe, tickers, cg] = await Promise.all([
        fetchUniverse(),
        fetchAllTickers(),
        fetchCoinGeckoMarkets(250).catch((e) => {
          console.warn('[admission] coingecko failed:', e);
          return [] as Array<{ id: string; symbol: string; market_cap_rank: number | null }>;
        }),
      ]);

      const cgRankBySymbol = new Map<string, number>();
      for (const c of cg) {
        if (c.market_cap_rank == null) continue;
        const prev = cgRankBySymbol.get(c.symbol);
        if (prev == null || c.market_cap_rank < prev) cgRankBySymbol.set(c.symbol, c.market_cap_rank);
      }
      const { data: mapping } = await supabase
        .from('coin_admission_coingecko_map')
        .select('bybit_symbol, coingecko_id');
      const manualMap = new Map<string, string>();
      for (const m of mapping ?? []) manualMap.set(m.bybit_symbol, m.coingecko_id);
      const cgById = new Map<string, { rank: number | null }>();
      for (const c of cg) cgById.set(c.id, { rank: c.market_cap_rank });

      const ranked = universe
        .map((inst) => ({ inst, t: tickers.get(inst.symbol)?.turnover24h ?? 0 }))
        .sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
      const cap = data.maxSymbols ?? ranked.length;
      const slice = ranked.slice(0, cap);

      await supabase
        .from('coin_admission_runs')
        .update({ symbols_total: slice.length, progress_total: slice.length })
        .eq('id', runId);

      let done = 0;
      const rows: any[] = [];

      await pMapLimit(slice, 10, async ({ inst }) => {
        const symbol = inst.symbol;
        const ticker = tickers.get(symbol);

        let rank: number | null = null;
        const manualId = manualMap.get(symbol);
        if (manualId && cgById.has(manualId)) {
          rank = cgById.get(manualId)?.rank ?? null;
        } else {
          rank = cgRankBySymbol.get(inst.baseCoin.toLowerCase()) ?? null;
        }

        let dailyBars: any[] | null = null;
        let hourlyBars: any[] | null = null;
        let bars5m: any[] | null = null;
        let bars15m: any[] | null = null;
        let fetchError: string | null = null;

        const daily = await fetchDailyKline(symbol, 30);
        if (daily.ok) dailyBars = daily.bars;
        else fetchError = `daily:${daily.error}`;

        if (!data.skipWickAnalysis) {
          const hourly = await fetchHourlyKline(symbol, 720);
          if (hourly.ok) hourlyBars = hourly.bars;
          else fetchError = (fetchError ? fetchError + ';' : '') + `hourly:${hourly.error}`;
        }

        if (includeTrend) {
          const [k5, k15] = await Promise.all([
            fetch5mKline(symbol, 576),
            fetch15mKline(symbol, 288),
          ]);
          if (k5.ok) bars5m = k5.bars;
          else fetchError = (fetchError ? fetchError + ';' : '') + `5m:${k5.error}`;
          if (k15.ok) bars15m = k15.bars;
          else fetchError = (fetchError ? fetchError + ';' : '') + `15m:${k15.error}`;
          // Ensure hourly is loaded for trend confirmation even if wick skipped
          if (!hourlyBars && data.skipWickAnalysis) {
            const h = await fetchHourlyKline(symbol, 200);
            if (h.ok) hourlyBars = h.bars;
          }
        }

        const metrics = buildMetrics({
          symbol,
          instrument: inst,
          ticker,
          cgRank: rank,
          dailyBars,
          hourlyBars,
        });

        let trendScore: number | null = null;
        let trendComponents: any = null;
        if (includeTrend) {
          const tq = computeTrendQuality(
            bars5m as any,
            bars15m as any,
            hourlyBars as any,
          );
          if (tq) {
            trendScore = tq.score;
            trendComponents = tq.components;
          }
        }

        const scored = computeAdmissionScore(metrics, thresholds, weights, {
          mode: data.mode,
          trendScore,
        });

        rows.push({
          run_id: runId,
          symbol,
          status: scored.status,
          score: scored.score,
          trend_score: scored.trend_score,
          trend_components: trendComponents,
          strategy_fit_score: scored.strategy_fit_score,
          admission_mode: data.mode,
          admission_reason: scored.admission_reason,
          hard_kill_rules: scored.hard_kill_rules,
          soft_failures: scored.soft_failures,
          coingecko_id: manualId ?? null,
          rank: metrics.rank,
          turnover_24h: metrics.turnover_24h,
          turnover_7d_median: metrics.turnover_7d_median,
          turnover_30d_median: metrics.turnover_30d_median,
          open_interest_value: metrics.open_interest_value,
          spread_bps: metrics.spread_bps,
          slippage_bps_est: null,
          listing_age_days: metrics.listing_age_days,
          funding_rate: metrics.funding_rate,
          max_1h_drop_pct: metrics.max_1h_drop_pct,
          wick_risk_score: scored.wick_risk_score,
          extreme_wick_count: metrics.extreme_wick_count,
          components: scored.components,
          kill_rules_triggered: scored.kill_rules_triggered,
          fetch_error: fetchError,
        });

        done++;
        if (done % 25 === 0) {
          await supabase
            .from('coin_admission_runs')
            .update({ progress_done: done })
            .eq('id', runId);
        }
      });

      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error: insErr } = await supabase.from('coin_admission_results').insert(chunk);
        if (insErr) throw new Error(`results_insert_failed:${insErr.message}`);
      }

      const approved = rows.filter((r) => r.status === 'approved').length;
      const watchlist = rows.filter((r) => r.status === 'watchlist').length;
      const trendCandidate = rows.filter((r) => r.status === 'trend_candidate').length;
      const rejected = rows.filter((r) => r.status === 'rejected').length;

      await supabase
        .from('coin_admission_runs')
        .update({
          status: 'completed',
          finished_at: new Date().toISOString(),
          progress_done: rows.length,
          approved_n: approved,
          watchlist_n: watchlist + trendCandidate,
          rejected_n: rejected,
        })
        .eq('id', runId);

      return {
        runId,
        symbols_total: rows.length,
        approved,
        watchlist,
        trend_candidate: trendCandidate,
        rejected,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      await supabase
        .from('coin_admission_runs')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          error: msg.slice(0, 1000),
        })
        .eq('id', runId);
      throw new Error(msg);
    }
  });
