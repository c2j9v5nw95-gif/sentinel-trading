// record-health — Phase 2. Stores type=stats snapshot keyed by
// (normalized_symbol, strategy, tag).
import { corsHeaders } from "../_shared/db.ts";
Deno.serve(async (_req) =>
  new Response(JSON.stringify({ todo: "phase 2" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  }),
);
