// execution-mode — resolves whether a signal should execute live or paper.
//
// Order of precedence:
//   1. symbols.execution_mode_override (per-symbol force)
//   2. app_settings.paper_mode_enabled  (global default)
//   3. fallback: 'paper' (safe default — never accidentally go live)
//
// Resolution is sticky per row: once stamped on a job/order/position, the row
// keeps its mode even if global flags flip later.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type ExecutionMode = "live" | "paper";

export async function resolveExecutionMode(
  sb: SupabaseClient,
  symbol: string,
): Promise<{ mode: ExecutionMode; source: "symbol_override" | "global" | "fallback" }> {
  const [{ data: sym }, { data: settings }] = await Promise.all([
    sb.from("symbols").select("execution_mode_override").eq("symbol", symbol).maybeSingle(),
    sb.from("app_settings").select("paper_mode_enabled").maybeSingle(),
  ]);

  const override = sym?.execution_mode_override as ExecutionMode | null | undefined;
  if (override === "live" || override === "paper") {
    return { mode: override, source: "symbol_override" };
  }
  if (settings) {
    return {
      mode: settings.paper_mode_enabled ? "paper" : "live",
      source: "global",
    };
  }
  return { mode: "paper", source: "fallback" };
}
