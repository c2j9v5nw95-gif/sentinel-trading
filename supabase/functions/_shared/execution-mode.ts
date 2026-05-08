// execution-mode — resolves which client (paper, testnet, live) executes a signal.
//
// Order of precedence:
//   1. symbols.execution_mode_override (per-symbol force)
//      NULL  → "inherit_global" — fall through to global setting
//      'paper' | 'testnet' | 'live' → force that mode
//   2. app_settings — paper > testnet > live (whichever flag is on)
//   3. fallback: 'paper' (safe default)
//
// Live mode: even when chosen, callers must additionally pass liveExecutionGate
// before constructing a LiveBybitClient. resolveExecutionMode merely reports
// the *intended* mode; the factory in bybit-client.ts enforces the safety gate.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type ExecutionMode = "live" | "paper" | "testnet";

export async function resolveExecutionMode(
  sb: SupabaseClient,
  symbol: string,
): Promise<{ mode: ExecutionMode; source: "symbol_override" | "global" | "fallback" }> {
  const [{ data: sym }, { data: settings }] = await Promise.all([
    sb.from("symbols").select("execution_mode_override").eq("symbol", symbol).maybeSingle(),
    sb.from("app_settings").select("paper_mode_enabled,testnet_enabled,live_enabled").maybeSingle(),
  ]);

  const override = sym?.execution_mode_override as ExecutionMode | null | undefined;
  if (override === "live" || override === "paper" || override === "testnet") {
    return { mode: override, source: "symbol_override" };
  }
  if (settings) {
    if (settings.paper_mode_enabled) return { mode: "paper", source: "global" };
    if (settings.testnet_enabled)    return { mode: "testnet", source: "global" };
    if (settings.live_enabled)       return { mode: "live", source: "global" };
  }
  return { mode: "paper", source: "fallback" };
}
