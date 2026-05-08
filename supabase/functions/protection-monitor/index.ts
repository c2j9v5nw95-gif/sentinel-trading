// protection-monitor — cron, ~15s — Phase 3.
// Reconciles positions vs Bybit, activates TSL on per-symbol threshold,
// re-arms missing SLs, flags drift.
import { corsHeaders } from "../_shared/db.ts";
Deno.serve(async (_req) =>
  new Response(JSON.stringify({ todo: "phase 3" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  }),
);
