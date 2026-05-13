// Signal-context snapshot writer core.
// Read-only: fetches public klines via bridge passthrough and inserts rows
// into signal_context_snapshots. Idempotent on (signal_id, timeframe).

import { supabaseAdmin } from '@/integrations/supabase/client.server';
import { fetchKline } from './bybit-public-kline';
import { computeRegime } from './regime';
import { isTimeframe, resolveTimeframe, type Timeframe } from './timeframe';
import { closeRun, openRun } from './run-logger';

export interface SignalContextResult {
  ok: boolean;
  signal_id: string;
  trade_timeframe: Timeframe | null;
  environment: string | null;
  rows_written: number;
  api_calls: number;
  errors: Array<Record<string, unknown>>;
  dry_run: boolean;
  skipped?: string;
}

interface SignalRow {
  id: string;
  symbol: string | null;
  strategy: string | null;
  tag: string | null;
  type: string;
  payload: Record<string, unknown> | null;
}

async function resolveEnvironment(signalId: string): Promise<string> {
  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('execution_mode')
    .eq('signal_id', signalId)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (order?.execution_mode) return order.execution_mode as string;
  const { data: settings } = await supabaseAdmin
    .from('app_settings')
    .select('live_enabled, testnet_enabled')
    .limit(1)
    .maybeSingle();
  if (settings?.live_enabled) return 'live';
  if (settings?.testnet_enabled) return 'testnet';
  return 'paper';
}

export async function snapshotSignalContext(signalId: string): Promise<SignalContextResult> {
  const baseErrors: Array<Record<string, unknown>> = [];
  const result: SignalContextResult = {
    ok: false, signal_id: signalId, trade_timeframe: null, environment: null,
    rows_written: 0, api_calls: 0, errors: baseErrors, dry_run: false,
  };

  const { data: signal, error: sigErr } = await supabaseAdmin
    .from('signals')
    .select('id, symbol, strategy, tag, type, payload')
    .eq('id', signalId)
    .maybeSingle();
  if (sigErr || !signal) {
    result.errors.push({ kind: 'signal_not_found' });
    return result;
  }
  const sig = signal as unknown as SignalRow;
  if (sig.type !== 'entry' && sig.type !== 'exit') {
    result.ok = true; result.skipped = 'meta_signal';
    return result;
  }
  if (!sig.symbol) {
    result.ok = true; result.skipped = 'no_symbol';
    return result;
  }

  const run = await openRun('signal_context');

  const rawTf = (sig.payload?.timeframe ?? sig.payload?.interval ?? null) as unknown;
  const tradeTf = resolveTimeframe(rawTf);
  result.trade_timeframe = tradeTf;
  const environment = await resolveEnvironment(sig.id);
  result.environment = environment;

  // No timeframe: write a placeholder row so we have a record of the attempt.
  if (!tradeTf) {
    const { error: insErr } = await supabaseAdmin
      .from('signal_context_snapshots')
      .upsert({
        signal_id: sig.id,
        symbol: sig.symbol,
        strategy: sig.strategy,
        tag: sig.tag ?? '',
        environment,
        timeframe: null,
        tf_role: 'trade',
        payload: { reason: 'no_timeframe' } as any,
      }, { onConflict: 'signal_id,timeframe', ignoreDuplicates: true });
    if (insErr) result.errors.push({ kind: 'insert_failed', timeframe: null, message: insErr.message });
    else result.rows_written += 1;
    await closeRun(run, result.errors.length === 0);
    if (run) { run.errors = result.errors; run.rows_written = result.rows_written; }
    result.ok = result.errors.length === 0;
    return result;
  }

  // Resolve context TFs.
  const { data: ctxRows } = await supabaseAdmin
    .from('analytics_tf_context_map')
    .select('context_timeframe, priority')
    .eq('trade_timeframe', tradeTf)
    .eq('enabled', true)
    .order('priority', { ascending: true });
  const contextTfs: Timeframe[] = (ctxRows ?? [])
    .map((r) => r.context_timeframe)
    .filter(isTimeframe)
    .slice(0, 3);

  const tasks: Array<{ tf: Timeframe; role: 'trade' | 'context'; limit: number }> = [
    { tf: tradeTf, role: 'trade', limit: 200 },
    ...contextTfs.map((tf) => ({ tf, role: 'context' as const, limit: 100 })),
  ];

  const fetched = await Promise.allSettled(
    tasks.map((t) => fetchKline(sig.symbol!, t.tf, t.limit)),
  );
  result.api_calls = tasks.length;

  const inserts: any[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const r = fetched[i];
    if (r.status !== 'fulfilled' || !r.value.ok) {
      const failure = r.status === 'fulfilled' && r.value.ok === false ? r.value : null;
      const rejection = r.status === 'rejected' ? (r.reason as Error)?.message : null;
      const err = failure ? failure.error : rejection;
      const httpStatus = failure ? failure.http_status : null;
      result.errors.push({ kind: 'fetch_failed', timeframe: t.tf, http_status: httpStatus, error_kind: err, via: 'bridge' });
      inserts.push({
        signal_id: sig.id, symbol: sig.symbol, strategy: sig.strategy, tag: sig.tag ?? '',
        environment, timeframe: t.tf, tf_role: t.role, bar_time: null,
        payload: { error: err ?? 'unknown' },
      });
      continue;
    }
    const bars = r.value.bars;
    if (!bars.length) {
      result.errors.push({ kind: 'no_bars', timeframe: t.tf });
      continue;
    }
    const reg = computeRegime(bars);
    const lastBar = bars[bars.length - 1];
    const payload: Record<string, unknown> = t.role === 'trade'
      ? {
          atr: reg.payload.atr,
          atr_pct: reg.payload.atr_pct,
          candle_range_pct: reg.payload.candle_range_pct,
          ema20: reg.payload.ema20,
          ema50: reg.payload.ema50,
          ema200: reg.payload.ema200,
          ema_slope_pct: reg.payload.ema_slope_pct,
          dist_from_ema50_pct: reg.payload.dist_from_ema50_pct,
          rsi14: null, // RSI calc only on close series — kept null for parity with adx14 path; computed below
          adx14: reg.payload.adx14,
          volume: lastBar.volume,
          rel_volume_20: reg.payload.rel_volume_20,
          regime_class: reg.regime_class,
        }
      : {
          ema_slope_pct: reg.payload.ema_slope_pct,
          adx14: reg.payload.adx14,
          atr_pct: reg.payload.atr_pct,
          rel_volume_20: reg.payload.rel_volume_20,
          dist_from_ema50_pct: reg.payload.dist_from_ema50_pct,
          regime_class: reg.regime_class,
        };
    // Compute RSI14 cheaply for trade-TF.
    if (t.role === 'trade') {
      const closes = bars.map((b) => b.close);
      const { rsi } = await import('./indicators');
      payload.rsi14 = rsi(closes, 14);
    }
    inserts.push({
      signal_id: sig.id, symbol: sig.symbol, strategy: sig.strategy, tag: sig.tag ?? '',
      environment, timeframe: t.tf, tf_role: t.role,
      bar_time: new Date(lastBar.bar_time).toISOString(),
      payload,
    });
  }

  if (inserts.length) {
    const { error: insErr, count } = await supabaseAdmin
      .from('signal_context_snapshots')
      .upsert(inserts, { onConflict: 'signal_id,timeframe', ignoreDuplicates: true, count: 'exact' });
    if (insErr) {
      result.errors.push({ kind: 'insert_failed', message: insErr.message });
    } else {
      result.rows_written = count ?? inserts.length;
    }
  }

  if (run) {
    run.errors = result.errors; run.rows_written = result.rows_written;
    run.api_calls = result.api_calls; run.symbols_processed = 1;
  }
  await closeRun(run, result.errors.length === 0);
  result.ok = result.errors.length === 0;
  return result;
}
