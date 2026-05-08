// op-bybit-proxy — Phase 3. Narrow read-only Bybit proxy for the dashboard
// (positions, balances, open orders). Operator JWT + role required.
import { corsHeaders } from "../_shared/db.ts";
Deno.serve(async (_req) =>
  new Response(JSON.stringify({ todo: "phase 3" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  }),
);
