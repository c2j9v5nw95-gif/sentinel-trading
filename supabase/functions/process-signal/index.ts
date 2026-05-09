// process-signal — Phase 2 worker.
// Two modes:
//   POST { signal_id }  → dispatch one signal
//   POST {}             → cron mode: claim & dispatch up to BATCH queued signals
import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { dispatchSignal } from "../_shared/dispatcher.ts";
import { LIVE_GATE_WORKER_VERSION } from "../_shared/live-client.ts";

const BATCH = 25;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const sb = serviceClient();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  if (body?.signal_id) {
    console.log(JSON.stringify({ evt: "process_signal_worker_version", worker_version: LIVE_GATE_WORKER_VERSION, signal_id: String(body.signal_id) }));
    const result = await dispatchSignal(sb, String(body.signal_id));
    return new Response(JSON.stringify({ ok: true, worker_version: LIVE_GATE_WORKER_VERSION, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Batch mode
  const { data: queued } = await sb
    .from("signals")
    .select("id")
    .eq("status", "queued")
    .order("received_at", { ascending: true })
    .limit(BATCH);

  const results = [];
  for (const row of queued ?? []) {
    results.push(await dispatchSignal(sb, row.id));
  }

  return new Response(JSON.stringify({ ok: true, worker_version: LIVE_GATE_WORKER_VERSION, processed: results.length, results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
