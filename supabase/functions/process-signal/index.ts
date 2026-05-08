// process-signal — Phase 2.
// Pulls queued signals and dispatches:
//   type=stats   -> record-health
//   type=trade   -> Health Gate + Risk Engine + transport-pref check
//                   -> execute-entry / execute-exit
import { serviceClient, corsHeaders } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const _sb = serviceClient();
  // TODO Phase 2: implement queue worker.
  return new Response(JSON.stringify({ ok: true, todo: "phase 2" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
