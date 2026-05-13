// Periodic regime snapshot writer core.
// Read-only: fetches public klines for (symbol, timeframe) and inserts rows
// into regime_snapshots.

import { supabaseAdmin } from '@/integrations/supabase/client.server';
import { fetchKline } from './bybit-public-kline';
import { computeRegime } from './regime';
import { isTimeframe, type Timeframe } from './timeframe';
import { closeRun, openRun } from './run-logger';

export type Schedule = 'trade' | 'context' | 'manual';

const TRADE_TFS: Timeframe[] = ['5m', '15m', '30m'];
const CONTEXT_TFS: Timeframe[] = ['1h', '4h', '1d'];
const HARD_SYMBOL_CAP = 30;
const POOL = 5;
const THROTTLE_MS = 50;

export interface RegimeTickResult {
  ok: boolean;
  run_id: string | null;
  schedule: Schedule;
  dry_run: boolean;
  symbols_processed: number;
  rows_written: number;
  api_calls: number;
  errors: Array<Record<string, unknown>>;
  error?: string;
}

function tfsForSchedule(schedule: Schedule, override?: string[]): Timeframe[] | { error: string } {
  if (override && override.length) {
    const ok = override.filter(isTimeframe);
    if (!ok.length) return { error: 'no_valid_timeframes' };
    return ok as Timeframe[];
  }
  if (schedule === 'trade') return TRADE_TFS;
  if (schedule === 'context') return CONTEXT_TFS;
  return { error: 'manual_requires_timeframes' };
}

async function resolveSymbols(override?: string[]): Promise<string[] | { error: string }> {
  if (override && override.length) {
    if (override.length > HARD_SYMBOL_CAP) return { error: 'universe_too_large' };
    return override;
  }
  const { data, error } = await supabaseAdmin
    .from('symbols')
    .select('symbol')
    .eq('enabled', true);
  if (error) return { error: `symbol_query_failed:${error.message}` };
  const symbols = (data ?? []).map((r) => r.symbol);
  if (symbols.length > HARD_SYMBOL_CAP) return { error: 'universe_too_large' };
  return symbols;
}

export async function snapshotRegimeTick(input: {
  schedule: Schedule;
  symbols?: string[];
  timeframes?: string[];
  dry_run?: boolean;
}): Promise<RegimeTickResult> {
  const dry_run = !!input.dry_run;
  const result: RegimeTickResult = {
    ok: false, run_id: null, schedule: input.schedule, dry_run,
    symbols_processed: 0, rows_written: 0, api_calls: 0, errors: [],
  };

  const tfRes = tfsForSchedule(input.schedule, input.timeframes);
  if ('error' in tfRes) { result.error = tfRes.error; return result; }
  const symRes = await resolveSymbols(input.symbols);
  if ('error' in symRes) { result.error = symRes.error; return result; }

  const tfs = tfRes;
  const symbols = symRes;
  if (!symbols.length) { result.ok = true; return result; }

  const run = await openRun('regime');
  result.run_id = run?.id ?? null;

  const tasks: Array<{ symbol: string; tf: Timeframe }> = [];
  for (const s of symbols) for (const tf of tfs) tasks.push({ symbol: s, tf });

  // Bounded pool.
  let cursor = 0;
  const inserts: any[] = [];
  async function worker() {
    while (cursor < tasks.length) {
      const idx = cursor++;
      const t = tasks[idx];
      const r = await fetchKline(t.symbol, t.tf, 220);
      result.api_calls += 1;
      if (!r.ok) {
        result.errors.push({ kind: 'fetch_failed', symbol: t.symbol, timeframe: t.tf, http_status: r.http_status, error_kind: r.error, via: 'bridge' });
      } else if (!r.bars.length) {
        result.errors.push({ kind: 'no_bars', symbol: t.symbol, timeframe: t.tf });
      } else {
        const reg = computeRegime(r.bars);
        const lastBar = r.bars[r.bars.length - 1];
        inserts.push({
          symbol: t.symbol,
          timeframe: t.tf,
          bar_time: new Date(lastBar.bar_time).toISOString(),
          regime_class: reg.regime_class,
          payload: reg.payload,
        });
      }
      if (THROTTLE_MS > 0) await new Promise((res) => setTimeout(res, THROTTLE_MS));
    }
  }
  const workers = Array.from({ length: Math.min(POOL, tasks.length) }, () => worker());
  await Promise.all(workers);
  result.symbols_processed = symbols.length;

  if (!dry_run && inserts.length) {
    const { error, count } = await supabaseAdmin
      .from('regime_snapshots')
      .insert(inserts, { count: 'exact' });
    if (error) result.errors.push({ kind: 'insert_failed', message: error.message });
    else result.rows_written = count ?? inserts.length;
  } else if (dry_run) {
    result.rows_written = 0;
  }

  if (run) {
    run.errors = result.errors;
    run.rows_written = result.rows_written;
    run.api_calls = result.api_calls;
    run.symbols_processed = result.symbols_processed;
  }
  await closeRun(run, result.errors.length === 0);
  result.ok = result.errors.length === 0;
  return result;
}
