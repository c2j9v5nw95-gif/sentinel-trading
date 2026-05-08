// execute-entry — manual / replay invocation. Normal path is via dispatcher.
// POST { signal_id } runs executeEntry under a symbol lock for that signal.
import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { executeEntry } from "../_shared/executor.ts";
import { resolveExecutionMode } from "../_shared/execution-mode.ts";
import { withSymbolLock } from "../_shared/locks.ts";
import { Trail, flushTrail } from "../_shared/trail.ts";
import { computeEntrySizing, validateSymbolSizing } from "../_shared/sizing.ts";

export { computeEntrySizing, validateSymbolSizing };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const sb = serviceClient();
  const body = await req.json().catch(() => ({}));
  const { data: signal } = await sb.from("signals").select("*").eq("id", body.signal_id).maybeSingle();
  if (!signal) return new Response(JSON.stringify({ ok: false, error: "signal_not_found" }),
    { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const trail = new Trail();
  for (const s of (signal.decision_trail ?? [])) trail.add(s.step, s.outcome, s.reason, s.metrics);
  const mode = await resolveExecutionMode(sb, signal.symbol);
  const result = await withSymbolLock(sb, signal.symbol, "entry",
    { signalId: signal.id }, async () => executeEntry(sb, signal, mode.mode, trail));
  await flushTrail(sb, signal.id, trail);
  return new Response(JSON.stringify({ ok: true, mode: mode.mode, result }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
