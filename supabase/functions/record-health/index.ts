// record-health — Phase 2.
// Thin wrapper around dispatcher for HEALTH (type=stats) signals. Same logic
// runs inline when process-signal pulls a stats signal from the queue, so this
// endpoint exists mainly for direct/manual invocation and clarity.
import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { dispatchSignal } from "../_shared/dispatcher.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const sb = serviceClient();
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  if (!body?.signal_id) {
    return new Response(JSON.stringify({ error: "signal_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const result = await dispatchSignal(sb, String(body.signal_id));
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
