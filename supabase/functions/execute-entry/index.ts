// execute-entry — Phase 3.
// Places entry on Bybit using per-symbol sizing, then immediately attaches a
// fixed SL. If SL placement fails after retries, marks position UNPROTECTED,
// raises critical alert, and pauses entries.
import { corsHeaders } from "../_shared/db.ts";
Deno.serve(async (_req) =>
  new Response(JSON.stringify({ todo: "phase 3" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  }),
);
