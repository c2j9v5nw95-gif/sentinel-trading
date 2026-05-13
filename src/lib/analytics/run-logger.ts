// Wrapper around analytics_snapshot_runs lifecycle.
import { supabaseAdmin } from '@/integrations/supabase/client.server';

export type WriterKind = 'signal_context' | 'regime';

export interface RunHandle {
  id: string;
  errors: Array<Record<string, unknown>>;
  symbols_processed: number;
  rows_written: number;
  api_calls: number;
}

export async function openRun(writer: WriterKind): Promise<RunHandle | null> {
  const { data, error } = await supabaseAdmin
    .from('analytics_snapshot_runs')
    .insert({ writer, started_at: new Date().toISOString(), ok: false })
    .select('id')
    .single();
  if (error || !data) {
    console.error('[analytics] openRun failed', error);
    return null;
  }
  return { id: data.id, errors: [], symbols_processed: 0, rows_written: 0, api_calls: 0 };
}

export async function closeRun(run: RunHandle | null, ok: boolean): Promise<void> {
  if (!run) return;
  await supabaseAdmin
    .from('analytics_snapshot_runs')
    .update({
      finished_at: new Date().toISOString(),
      ok: ok && run.errors.length === 0,
      symbols_processed: run.symbols_processed,
      rows_written: run.rows_written,
      api_calls: run.api_calls,
      errors: run.errors as any,
    })
    .eq('id', run.id);
}
