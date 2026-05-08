// execute-exit — Phase 3.
// Resolves quantity from current live Bybit position:
//   portion=tp1  -> tp1_exit_percent of live qty (CHECK ensures = 100 if tp2 disabled)
//   portion=rest -> remaining live qty
//   sl/opposite/trend_fail/failsafe -> 100% of live qty
import { corsHeaders } from "../_shared/db.ts";
Deno.serve(async (_req) =>
  new Response(JSON.stringify({ todo: "phase 3" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  }),
);
